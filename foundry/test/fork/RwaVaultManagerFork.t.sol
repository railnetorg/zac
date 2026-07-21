// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RwaVaultManager} from "src/RwaVaultManager.sol";
import {IMilkman} from "src/MilkmanSwapManager.sol";

/// @dev Subset of the Lagoon v0.6.0 vault used by this test.
interface ILagoonV06 {
    function owner() external view returns (address);
    function safe() external view returns (address);
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    function isTotalAssetsValid() external view returns (bool);
    function updateValuationManager(address valuationManager) external; // onlyOwner
    function settleDeposit(uint256 newTotalAssets) external; //            onlySafe onlyOpen
    function expireTotalAssets() external; //                             onlySafe
    function updateTotalAssetsLifespan(uint128 lifespan) external; //      onlySafe
    function updateMaxCap(uint256 maxCap) external; //                     onlySafe
}

/// @title  RwaVaultManagerForkTest
/// @notice Mainnet-fork e2e (RAIL-27) tying the whole thing together against LIVE contracts: a
///         `RwaVaultManager` installed as the real CoinShares v0.6.0 USDC Lagoon vault's
///         `valuationManager`, computing NAV from real balances + real Chainlink feeds and driving
///         the two-step settle — AND the quiescence gate integrated with the real deployed Milkman.
/// @dev    A real CoW solver fill is not reproducible on a fork (no solver network; the repo's own
///         `test/fork/templates/Milkman.t.sol` notes fills were exercised live on mainnet). So the
///         "order in-flight -> cleared -> NAV" state machine is exercised via the REAL `cancelSwap`
///         (fully live), and the post-fill NAV accounting is covered by the unit test
///         `test_pushNav_worksAgainAfterFill`. Requires `MAINNET_RPC_URL` (contracts-fork profile).
contract RwaVaultManagerForkTest is Test {
    address constant VAULT = 0xa8B819AFd31f41b0243543f9396678CCb8bA04a6; // v0.6.0 USDC Lagoon (empty)
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // 6-dec
    address constant USDC_USD_FEED = 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6; // Chainlink USDC/USD, 8-dec
    address constant SPYon = 0xFeDC5f4a6c38211c1338aa411018DFAf26612c08; // 18-dec Ondo GM token
    address constant SPY_FEED = 0xd16cC387E87d37350f57421DaDF811968441C1a5; // Chainlink Calculated, 8-dec
    address constant MILKMAN = 0x060373D064d0168931dE2AB8DDA7410923d06E88;
    address constant PRICE_CHECKER = 0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c;

    address constant KEEPER = address(0xCA11);
    bytes32 constant APP_DATA = keccak256("railnet-rwa");
    uint256 constant MAX_FEED_AGE = 7 days; // generous for the fork (equity feed heartbeat 24/5 + weekend)

    RwaVaultManager mgr;
    address owner;
    address safe;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        require(ILagoonV06(VAULT).asset() == USDC, "vault asset != USDC");
        owner = ILagoonV06(VAULT).owner();
        safe = ILagoonV06(VAULT).safe();

        RwaVaultManager.HoldingConfig[] memory holdings = new RwaVaultManager.HoldingConfig[](1);
        holdings[0] = RwaVaultManager.HoldingConfig({token: SPYon, feed: SPY_FEED, maxAge: MAX_FEED_AGE});
        mgr = new RwaVaultManager(VAULT, KEEPER, IMilkman(MILKMAN), USDC_USD_FEED, MAX_FEED_AGE, holdings);
        assertEq(mgr.SAFE(), safe, "manager should pin the vault's safe");

        // Install as the vault's valuationManager (owner-gated) and give the Safe settle headroom.
        vm.prank(owner);
        ILagoonV06(VAULT).updateValuationManager(address(mgr));
        vm.startPrank(safe);
        ILagoonV06(VAULT).updateMaxCap(type(uint256).max);
        ILagoonV06(VAULT).updateTotalAssetsLifespan(uint128(type(uint64).max));
        IERC20(USDC).approve(address(mgr), type(uint256).max); // so openSwap can pull from the Safe
        vm.stopPrank();

        // Controlled book: 100k USDC idle + 500 SPYon.
        deal(USDC, safe, 100_000e6);
        deal(SPYon, safe, 500e18);
    }

    /// NAV values both legs against the live vault and drives the real two-step settle.
    function test_fork_navSettler_drivesSettle() public {
        uint256 expected = mgr.previewNav();
        assertGt(expected, 100_000e6, "GM leg not priced into NAV");

        vm.prank(safe);
        try ILagoonV06(VAULT).expireTotalAssets() {} catch {}

        vm.prank(KEEPER);
        uint256 pushed = mgr.pushNav();
        assertEq(pushed, expected, "pushed != previewed");

        vm.prank(safe);
        ILagoonV06(VAULT).settleDeposit(pushed);

        assertEq(ILagoonV06(VAULT).totalAssets(), pushed, "vault totalAssets != pushed NAV");
        assertTrue(ILagoonV06(VAULT).isTotalAssetsValid(), "NAV should be fresh after settle");
    }

    /// A real in-flight Milkman order blocks pushNav (quiescence); the real cancel clears it, then
    /// NAV + settle proceed — end to end against live Milkman + live vault.
    function test_fork_quiescenceGate_blocksNavThenCancelUnblocks() public {
        // Open a real USDC->SPYon order: the real Milkman deploys a clone and escrows 500 USDC.
        address clone = vm.computeCreateAddress(MILKMAN, vm.getNonce(MILKMAN));
        vm.prank(KEEPER);
        mgr.openSwap(500e6, IERC20(USDC), IERC20(SPYon), APP_DATA, PRICE_CHECKER, hex"", clone);
        assertGt(clone.code.length, 0, "real clone deployed");
        assertEq(IERC20(USDC).balanceOf(clone), 500e6, "escrow in real clone");
        assertTrue(mgr.isPending());

        // NAV is blocked while the order is in flight.
        vm.prank(KEEPER);
        vm.expectRevert(RwaVaultManager.OrderInFlight.selector);
        mgr.pushNav();

        // Real cancel reclaims the escrow to the Safe (clears the live creator-proof).
        vm.prank(KEEPER);
        mgr.cancelSwap();
        assertEq(IERC20(USDC).balanceOf(safe), 100_000e6, "USDC reclaimed to Safe");
        assertFalse(mgr.isPending());

        // Now quiescent: NAV + settle work.
        vm.prank(safe);
        try ILagoonV06(VAULT).expireTotalAssets() {} catch {}
        vm.prank(KEEPER);
        uint256 pushed = mgr.pushNav();
        vm.prank(safe);
        ILagoonV06(VAULT).settleDeposit(pushed);
        assertEq(ILagoonV06(VAULT).totalAssets(), pushed, "vault totalAssets != pushed NAV");
    }
}
