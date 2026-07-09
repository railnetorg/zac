// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {NavSettler, IAggregatorV3} from "src/NavSettler.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFeed is IAggregatorV3 {
    uint8 public decimals;
    int256 internal _answer;
    uint256 internal _updatedAt;

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
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}

contract MockVault {
    address public asset;
    address public safe;
    uint256 public lastNav;
    uint256 public calls;

    constructor(address asset_, address safe_) {
        asset = asset_;
        safe = safe_;
    }

    function setSafe(address safe_) external {
        safe = safe_;
    }

    function updateNewTotalAssets(uint256 x) external {
        lastNav = x;
        calls++;
    }
}

contract NavSettlerTest is Test {
    uint256 constant MAX_AGE = 3 days;
    address constant HOLDER = address(0x5AFE);
    address constant KEEPER = address(0xCAFE);

    MockERC20 usdc; // 6-dec base
    MockERC20 spy; //  18-dec GM token
    MockFeed spyFeed; // 8-dec USD feed ($748)
    MockFeed usdcFeed; // 8-dec USDC/USD ($1)
    MockVault vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        spy = new MockERC20("SPDR S&P 500 (Ondo)", "SPYon", 18);
        spyFeed = new MockFeed(8, 748e8, block.timestamp);
        usdcFeed = new MockFeed(8, 1e8, block.timestamp);
        vault = new MockVault(address(usdc), HOLDER);
    }

    function _cfg(address token, address feed) internal pure returns (NavSettler.HoldingConfig[] memory c) {
        c = new NavSettler.HoldingConfig[](1);
        c[0] = NavSettler.HoldingConfig({token: token, feed: feed, maxAge: MAX_AGE});
    }

    function _deploy(NavSettler.HoldingConfig[] memory holdings) internal returns (NavSettler) {
        return new NavSettler(address(vault), KEEPER, address(usdcFeed), MAX_AGE, holdings);
    }

    function _single() internal returns (NavSettler) {
        return _deploy(_cfg(address(spy), address(spyFeed)));
    }

    function test_nav_singleAsset_decimalNormalization() public {
        NavSettler n = _single();
        usdc.mint(HOLDER, 1_000e6); // 1000 USDC idle
        spy.mint(HOLDER, 2e18); //     2 SPYon @ $748 = $1496 (= 1496 USDC at peg)
        assertEq(n.previewNav(), 2496e6, "nav mismatch");
    }

    function test_nav_baseOnly_whenNoTokens() public {
        NavSettler n = _single();
        usdc.mint(HOLDER, 500e6);
        assertEq(n.previewNav(), 500e6, "base-only nav");
    }

    function test_nav_multiAsset_sum() public {
        MockERC20 qqq = new MockERC20("Invesco QQQ (Ondo)", "QQQon", 18);
        MockFeed qqqFeed = new MockFeed(8, 700e8, block.timestamp);

        NavSettler.HoldingConfig[] memory c = new NavSettler.HoldingConfig[](2);
        c[0] = NavSettler.HoldingConfig({token: address(spy), feed: address(spyFeed), maxAge: MAX_AGE});
        c[1] = NavSettler.HoldingConfig({token: address(qqq), feed: address(qqqFeed), maxAge: MAX_AGE});
        NavSettler n = _deploy(c);

        usdc.mint(HOLDER, 100e6);
        spy.mint(HOLDER, 1e18); // $748
        qqq.mint(HOLDER, 3e18); // $2100
        assertEq(n.previewNav(), 2948e6, "multi-asset nav");
    }

    function test_nav_fractionalToken() public {
        NavSettler n = _single();
        spy.mint(HOLDER, 5e17); // 0.5 SPYon @ $748 = $374
        assertEq(n.previewNav(), 374e6, "fractional token value");
    }

    function test_nav_usdcDepeg_raisesUsdPricedLegs() public {
        NavSettler n = _single();
        spy.mint(HOLDER, 1e18); // 1 SPYon, no idle USDC

        assertEq(n.previewNav(), 748e6, "at peg");

        usdcFeed.set(98e6, block.timestamp); // USDC/USD = $0.98 (depeg)
        // 1 SPYon still $748, now worth 748 / 0.98 = ~763.27 USDC
        uint256 navDepeg = n.previewNav();
        assertGt(navDepeg, 748e6, "depeg should raise USDC-denominated NAV");
        assertApproxEqAbs(navDepeg, uint256(748e6) * 1e8 / 98e6, 2, "depeg conversion");
    }

    function test_ok_atStalenessBoundary() public {
        NavSettler n = _single();
        spyFeed.set(748e8, block.timestamp - MAX_AGE);
        spy.mint(HOLDER, 1e18);
        assertEq(n.previewNav(), 748e6, "boundary allowed");
    }

    function test_revert_staleHoldingFeed() public {
        NavSettler n = _single();
        spy.mint(HOLDER, 1e18);
        spyFeed.set(748e8, block.timestamp - MAX_AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                NavSettler.StalePrice.selector, address(spyFeed), block.timestamp - MAX_AGE - 1, MAX_AGE + 1
            )
        );
        n.previewNav();
    }

    function test_revert_staleBaseFeed() public {
        NavSettler n = _single();
        spy.mint(HOLDER, 1e18);
        usdcFeed.set(1e8, block.timestamp - MAX_AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                NavSettler.StalePrice.selector, address(usdcFeed), block.timestamp - MAX_AGE - 1, MAX_AGE + 1
            )
        );
        n.previewNav();
    }

    function test_revert_nonPositivePrice() public {
        NavSettler n = _single();
        spy.mint(HOLDER, 1e18);
        spyFeed.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(NavSettler.NonPositivePrice.selector, address(spyFeed), int256(0)));
        n.previewNav();
    }

    function test_safe_readLive() public {
        NavSettler n = _single();
        spy.mint(HOLDER, 1e18);
        assertEq(n.previewNav(), 748e6);

        // Vault moves its safe -> NavSettler follows the new safe live (no redeploy).
        address newSafe = address(0xB0B);
        vault.setSafe(newSafe);
        assertEq(n.holder(), newSafe, "holder should track vault.safe()");
        assertEq(n.previewNav(), 0, "new (empty) safe -> nav 0");
        spy.mint(newSafe, 2e18);
        assertEq(n.previewNav(), 1496e6, "values the new safe");
    }

    function test_pushNav_onlyKeeper() public {
        NavSettler n = _single();
        usdc.mint(HOLDER, 10e6);
        vm.expectRevert(NavSettler.NotKeeper.selector);
        n.pushNav();
    }

    function test_pushNav_proposesToVault() public {
        NavSettler n = _single();
        usdc.mint(HOLDER, 100e6);
        spy.mint(HOLDER, 1e18);

        vm.expectEmit(true, true, true, true, address(n));
        emit NavSettler.NavPushed(848e6);
        vm.prank(KEEPER);
        uint256 nav = n.pushNav();

        assertEq(nav, 848e6, "returned nav");
        assertEq(vault.lastNav(), 848e6, "vault received nav");
        assertEq(vault.calls(), 1, "one proposal");
    }

    function test_revert_noHoldings() public {
        NavSettler.HoldingConfig[] memory empty = new NavSettler.HoldingConfig[](0);
        vm.expectRevert(NavSettler.NoHoldings.selector);
        _deploy(empty);
    }
}
