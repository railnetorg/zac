// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NavSettler} from "src/NavSettler.sol";

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

/// @notice Fork PoC (EVM-2676 / M4.1): a `NavSettler` installed as the Lagoon `valuationManager` prices a real,
///         empty v0.6.0 USDC Lagoon vault's holdings (idle USDC + Ondo GM SPYon via its Chainlink Calculated feed,
///         converted USD->USDC via the USDC/USD feed) and drives the two-step settle against the live protocol.
/// @dev    Target: CoinShares "USDC Permissionless DeFi Income" vault (already v0.6.0 + USDC + empty). Touched only
///         in the fork. Run:
///           MAINNET_RPC_URL=$(cat ~/.ethereum-mainnet-rpc) FOUNDRY_PROFILE=contracts-fork \
///             forge test --match-contract NavSettlerForkTest -vvv
contract NavSettlerForkTest is Test {
    address constant VAULT = 0xa8B819AFd31f41b0243543f9396678CCb8bA04a6; // v0.6.0 USDC Lagoon vault (empty)
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // 6-dec
    address constant USDC_USD_FEED = 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6; // Chainlink USDC/USD, 8-dec
    address constant SPYon = 0xFeDC5f4a6c38211c1338aa411018DFAf26612c08; // 18-dec Ondo GM token
    address constant SPY_FEED = 0xd16cC387E87d37350f57421DaDF811968441C1a5; // Chainlink Calculated, 8-dec

    address constant KEEPER = address(0xCA11);
    uint256 constant MAX_FEED_AGE = 7 days; // generous for the fork (equity feed heartbeat 24/5 + weekend)

    NavSettler nav;
    address owner;
    address safe;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        require(ILagoonV06(VAULT).asset() == USDC, "vault asset != USDC");
        owner = ILagoonV06(VAULT).owner();
        safe = ILagoonV06(VAULT).safe();

        NavSettler.HoldingConfig[] memory holdings = new NavSettler.HoldingConfig[](1);
        holdings[0] = NavSettler.HoldingConfig({token: SPYon, feed: SPY_FEED, maxAge: MAX_FEED_AGE});
        nav = new NavSettler(VAULT, KEEPER, USDC_USD_FEED, MAX_FEED_AGE, holdings);
        assertEq(nav.holder(), safe, "NavSettler should deduce the vault's safe");

        // Install our contract as the vault's valuationManager (owner-gated), and give the Safe headroom.
        vm.prank(owner);
        ILagoonV06(VAULT).updateValuationManager(address(nav));
        vm.startPrank(safe);
        ILagoonV06(VAULT).updateMaxCap(type(uint256).max);
        ILagoonV06(VAULT).updateTotalAssetsLifespan(uint128(type(uint64).max));
        vm.stopPrank();

        // Fund the Safe with a controlled book: 100k USDC idle + 500 SPYon.
        deal(USDC, safe, 100_000e6);
        deal(SPYon, safe, 500e18);
        assertEq(IERC20(USDC).balanceOf(safe), 100_000e6, "usdc deal failed");
        assertEq(IERC20(SPYon).balanceOf(safe), 500e18, "spyon deal failed");
    }

    function test_navSettler_isValuationManager_and_drivesSettle() public {
        // NAV values both legs and exceeds the idle-USDC-only figure (GM contributed).
        uint256 expected = nav.previewNav();
        assertGt(expected, 100_000e6, "GM leg not priced into NAV");

        // Two-step settle: expire cached NAV (safe) -> propose via NavSettler (valuationManager) -> confirm (safe).
        vm.prank(safe);
        try ILagoonV06(VAULT).expireTotalAssets() {} catch {}

        vm.prank(KEEPER);
        uint256 pushed = nav.pushNav(); // updateNewTotalAssets(nav) — only works because NavSettler IS the valuationManager
        assertEq(pushed, expected, "pushed != previewed");

        vm.prank(safe);
        ILagoonV06(VAULT).settleDeposit(pushed);

        // The live (empty) vault now reports exactly the NAV our contract computed from real balances + real feeds.
        assertEq(ILagoonV06(VAULT).totalAssets(), pushed, "vault totalAssets != pushed NAV");
        assertTrue(ILagoonV06(VAULT).isTotalAssetsValid(), "NAV should be fresh after settle");
    }

    function test_pushNav_reverts_ifNotValuationManager() public {
        vm.prank(owner);
        ILagoonV06(VAULT).updateValuationManager(address(0xDEAD));

        vm.prank(KEEPER);
        vm.expectRevert(); // vault rejects a non-valuationManager caller
        nav.pushNav();
    }
}
