// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RwaVaultManager} from "src/RwaVaultManager.sol";
import {MilkmanSwapManager, IMilkman} from "src/MilkmanSwapManager.sol";
import {MockMilkman, MockERC20} from "./MilkmanSwapManager.t.sol";

// ---- extra mocks (Lagoon vault + Chainlink feed) -------------------------------------------

contract MockLagoonVault {
    address public asset;
    address public safe;
    uint256 public lastPushed;
    bool public pushed;

    constructor(address _asset, address _safe) {
        asset = _asset;
        safe = _safe;
    }

    function setSafe(address s) external {
        safe = s;
    }

    function updateNewTotalAssets(uint256 v) external {
        lastPushed = v;
        pushed = true;
    }
}

contract MockAggregatorV3 {
    uint8 public decimals;
    int256 private _answer;
    uint256 private _updatedAt;

    constructor(uint8 d, int256 answer_, uint256 updatedAt_) {
        decimals = d;
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (0, _answer, 0, _updatedAt, 0);
    }
}

// --------------------------------------------------------------------------------------------

contract RwaVaultManagerTest is Test {
    MockERC20 usdc; // base asset (6 dec)
    MockERC20 gm; // priced holding (18 dec)
    MockAggregatorV3 usdcFeed; // USDC/USD (8 dec)
    MockAggregatorV3 gmFeed; // GM/USD   (8 dec)
    MockLagoonVault vault;
    MockMilkman milkman;
    RwaVaultManager mgr;

    address SAFE = makeAddr("safe");
    address KEEPER = makeAddr("keeper");
    address STRANGER = makeAddr("stranger");
    address PRICE_CHECKER = makeAddr("priceChecker");
    bytes32 APP_DATA = keccak256("railnet-rwa");
    uint256 constant MAX_AGE = 1 days;

    function setUp() public {
        vm.warp(1_700_000_000); // realistic unix ts so staleness math doesn't underflow the default (~1)
        usdc = new MockERC20("USD Coin", "USDC", 6);
        gm = new MockERC20("Ondo GM SPY", "SPYon", 18);
        usdcFeed = new MockAggregatorV3(8, 1e8, block.timestamp); // $1.00
        gmFeed = new MockAggregatorV3(8, 200e8, block.timestamp); // $200
        vault = new MockLagoonVault(address(usdc), SAFE);
        milkman = new MockMilkman();

        mgr = new RwaVaultManager(
            address(vault), KEEPER, IMilkman(address(milkman)), address(usdcFeed), MAX_AGE, _holdings()
        );

        // Safe holdings: 1000 USDC idle + 5 GM  (@ $200 = $1000) => NAV should be 2000 USDC.
        usdc.mint(SAFE, 1000e6);
        gm.mint(SAFE, 5e18);

        vm.prank(SAFE);
        usdc.approve(address(mgr), type(uint256).max);
    }

    function _holdings() internal view returns (RwaVaultManager.HoldingConfig[] memory h) {
        h = new RwaVaultManager.HoldingConfig[](1);
        h[0] = RwaVaultManager.HoldingConfig({token: address(gm), feed: address(gmFeed), maxAge: MAX_AGE});
    }

    // ---- pricing -----------------------------------------------------------------------------

    function test_previewNav_pricesBasePlusHolding() public view {
        // 1000e6 (idle USDC) + 5 GM * $200 -> 1000e6 base = 2000e6
        assertEq(mgr.previewNav(), 2000e6);
    }

    function test_previewNav_ignoresZeroBalanceHolding() public {
        // Drain the GM: NAV collapses to idle base only, and no GM feed read is required.
        deal(address(gm), SAFE, 0);
        assertEq(mgr.previewNav(), 1000e6);
    }

    function test_pushNav_postsToVault() public {
        vm.prank(KEEPER);
        uint256 nav = mgr.pushNav();
        assertEq(nav, 2000e6);
        assertTrue(vault.pushed());
        assertEq(vault.lastPushed(), 2000e6);
    }

    // ---- quiescence gate (the RAIL-27 core) --------------------------------------------------

    function test_pushNav_revertsWhileOrderInFlight() public {
        // Open a USDC->GM swap so a clone escrows USDC and isPending() is true.
        address clone = vm.computeCreateAddress(address(milkman), vm.getNonce(address(milkman)));
        vm.prank(KEEPER);
        mgr.openSwap(500e6, usdc, gm, APP_DATA, PRICE_CHECKER, hex"", clone);
        assertTrue(mgr.isPending());

        vm.prank(KEEPER);
        vm.expectRevert(RwaVaultManager.OrderInFlight.selector);
        mgr.pushNav();
    }

    function test_pushNav_worksAgainAfterFill() public {
        address clone = vm.computeCreateAddress(address(milkman), vm.getNonce(address(milkman)));
        vm.prank(KEEPER);
        mgr.openSwap(500e6, usdc, gm, APP_DATA, PRICE_CHECKER, hex"", clone);

        // Simulate the CoW fill: clone emptied, proceeds delivered to the Safe.
        deal(address(usdc), clone, 0);
        deal(address(gm), SAFE, 5e18 + 25e17); // +2.5 GM bought with the 500 USDC @ $200
        assertFalse(mgr.isPending());

        vm.prank(KEEPER);
        uint256 nav = mgr.pushNav();
        // Safe now: 500 USDC + 7.5 GM*$200 = 500 + 1500 = 2000 USDC
        assertEq(nav, 2000e6);
    }

    // ---- fail-closed guards ------------------------------------------------------------------

    function test_pushNav_revertsIfSafeMoved() public {
        vault.setSafe(makeAddr("newsafe"));
        vm.prank(KEEPER);
        vm.expectRevert(RwaVaultManager.SafeMoved.selector);
        mgr.pushNav();
    }

    function test_pushNav_revertsForNonKeeper() public {
        vm.prank(STRANGER);
        vm.expectRevert(MilkmanSwapManager.NotKeeper.selector);
        mgr.pushNav();
    }

    function test_previewNav_revertsOnStaleHoldingFeed() public {
        gmFeed.set(200e8, block.timestamp - MAX_AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RwaVaultManager.StalePrice.selector, address(gmFeed), block.timestamp - MAX_AGE - 1, MAX_AGE + 1
            )
        );
        mgr.previewNav();
    }

    function test_previewNav_revertsOnNonPositivePrice() public {
        gmFeed.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(RwaVaultManager.NonPositivePrice.selector, address(gmFeed), int256(0)));
        mgr.previewNav();
    }

    // ---- constructor guards ------------------------------------------------------------------

    function test_constructor_revertsOnNoHoldings() public {
        RwaVaultManager.HoldingConfig[] memory empty = new RwaVaultManager.HoldingConfig[](0);
        vm.expectRevert(RwaVaultManager.NoHoldings.selector);
        new RwaVaultManager(address(vault), KEEPER, IMilkman(address(milkman)), address(usdcFeed), MAX_AGE, empty);
    }

    function test_constructor_revertsOnBaseAssetHolding() public {
        RwaVaultManager.HoldingConfig[] memory h = new RwaVaultManager.HoldingConfig[](1);
        h[0] = RwaVaultManager.HoldingConfig({token: address(usdc), feed: address(usdcFeed), maxAge: MAX_AGE});
        vm.expectRevert(abi.encodeWithSelector(RwaVaultManager.BaseAssetHolding.selector, address(usdc)));
        new RwaVaultManager(address(vault), KEEPER, IMilkman(address(milkman)), address(usdcFeed), MAX_AGE, h);
    }

    function test_constructor_revertsOnDuplicateHolding() public {
        RwaVaultManager.HoldingConfig[] memory h = new RwaVaultManager.HoldingConfig[](2);
        h[0] = RwaVaultManager.HoldingConfig({token: address(gm), feed: address(gmFeed), maxAge: MAX_AGE});
        h[1] = RwaVaultManager.HoldingConfig({token: address(gm), feed: address(gmFeed), maxAge: MAX_AGE});
        vm.expectRevert(abi.encodeWithSelector(RwaVaultManager.DuplicateHolding.selector, address(gm)));
        new RwaVaultManager(address(vault), KEEPER, IMilkman(address(milkman)), address(usdcFeed), MAX_AGE, h);
    }
}
