// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {FlashLoanHelper} from "src/FlashLoanHelper.sol";
import {IFlashLoanHelper} from "src/interfaces/IFlashLoanHelper.sol";
import {ISafe} from "@safe/interfaces/ISafe.sol";
import {Enum} from "@safe/interfaces/Enum.sol";
import {IPool} from "@aave-v3-origin/interfaces/IPool.sol";
import {IPoolAddressesProvider} from "@aave-v3-origin/interfaces/IPoolAddressesProvider.sol";
import {IPoolConfigurator} from "@aave-v3-origin/interfaces/IPoolConfigurator.sol";
import {IACLManager} from "@aave-v3-origin/interfaces/IACLManager.sol";
import {DataTypes} from "@aave-v3-origin/protocol/libraries/types/DataTypes.sol";
import {ReserveConfiguration} from "@aave-v3-origin/protocol/libraries/configuration/ReserveConfiguration.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeDeployer} from "./SafeDeployer.sol";
import {AAVE_V3_POOL, MORPHO, USDC} from "./chainConfigs/MainnetAddresses.sol";

/// @title  FlashLoanHelperForkTest
/// @notice End-to-end fork tests against real mainnet Aave V3 + Morpho Blue + Safe v1.4.1.
/// @dev    Runs under `FOUNDRY_PROFILE=contracts-fork`. `RPC_URL` must point at an anvil RPC
///         (matching the convention used by `test/zac/ZacForkTest.sol`); hard-fails if unset.
///         The `forge-test-fork <upstream>` justfile target spawns anvil from the upstream
///         and exports `RPC_URL=http://127.0.0.1:8546` for both fork profiles. The Safe is
///         freshly deployed each run via the mainnet `SafeProxyFactory`, with this test
///         contract as the sole owner so it can sign txns via the pre-validated-signature
///         path (v=1).
contract FlashLoanHelperForkTest is Test, SafeDeployer {
    using ReserveConfiguration for DataTypes.ReserveConfigurationMap;

    bytes32 constant FALLBACK_HANDLER_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    // USDC has 6 decimals.
    uint256 constant INITIAL_USDC = 10_000e6;
    uint256 constant INITIAL_SUPPLY = 1_000e6;
    uint256 constant FLASH_AMOUNT = 1_000e6;
    uint256 constant MIN_HF = 1.1e18;

    // LTV set below the liquidation threshold (bps) when Aave holds no pending LTV to restore.
    uint256 constant FALLBACK_LTV_MARGIN = 300;

    FlashLoanHelper helper;
    ISafe safe;

    function setUp() public {
        // Hard-fail if RPC_URL unset — matches the convention in test/zac/ZacForkTest.sol.
        // Fork tests are opt-in via env, and missing env should error, not silently skip.
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        // The loop borrows USDC against USDC: it needs a non-zero collateral LTV on Aave.
        _ensureCollateralLtv(USDC);

        // Deploy a fresh Safe with this test contract as the sole owner (threshold = 1).
        safe = createSafe();

        helper = new FlashLoanHelper();

        // Fund the Safe with USDC and pre-supply some on Aave so the Boost loop has collateral
        // to borrow against: total collateral after Boost must cover the flash repayment.
        deal(USDC, address(safe), INITIAL_USDC);
        _execAsSafe(USDC, abi.encodeCall(IERC20.approve, (AAVE_V3_POOL, INITIAL_SUPPLY)), Enum.Operation.Call);
        _execAsSafe(
            AAVE_V3_POOL, abi.encodeCall(IPool.supply, (USDC, INITIAL_SUPPLY, address(safe), 0)), Enum.Operation.Call
        );
    }

    // ==================== Boost ====================

    /// Boost via Morpho flash (no premium): flash-borrow USDC, supply on Aave, borrow on Aave
    /// to repay the flash. Net: Safe gains `FLASH_AMOUNT` of leveraged USDC exposure.
    function test_boost_morphoFlash_usdcSameAsset() public {
        uint256 walletPre = IERC20(USDC).balanceOf(address(safe));
        (uint256 collateralPre, uint256 debtPre,,,,) = IPool(AAVE_V3_POOL).getUserAccountData(address(safe));

        _runLoop(_morphoBoostParams());

        (uint256 collateralPost, uint256 debtPost,,,, uint256 hfPost) =
            IPool(AAVE_V3_POOL).getUserAccountData(address(safe));

        // (Invariant 5) HF above floor
        assertGe(hfPost, MIN_HF, "HF below per-vehicle floor");

        // Position grew on both sides
        assertGt(collateralPost, collateralPre, "collateral did not grow");
        assertGt(debtPost, debtPre, "debt did not appear");

        // (Invariant 6) Wallet balance unchanged — the loop is net-zero on `p.asset`
        assertEq(IERC20(USDC).balanceOf(address(safe)), walletPre, "dust residual");

        _assertLoopHygiene();
    }

    /// Boost via Aave flash (5 bps premium): same as Morpho-flash Boost, but the flash venue
    /// charges a premium, and the Helper has to borrow `flashAmount + premium` on Aave to
    /// cover both the principal and the premium. Premium becomes part of the debt.
    function test_boost_aaveFlash_usdcSameAsset() public {
        uint256 walletPre = IERC20(USDC).balanceOf(address(safe));
        (uint256 collateralPre, uint256 debtPre,,,,) = IPool(AAVE_V3_POOL).getUserAccountData(address(safe));
        IERC20 variableDebt = IERC20(IPool(AAVE_V3_POOL).getReserveVariableDebtToken(USDC));
        uint256 variableDebtPre = variableDebt.balanceOf(address(safe));

        _runLoop(_aaveBoostParams());

        (uint256 collateralPost, uint256 debtPost,,,, uint256 hfPost) =
            IPool(AAVE_V3_POOL).getUserAccountData(address(safe));

        // (Invariant 5) HF above floor, even with the premium in the debt
        assertGe(hfPost, MIN_HF, "HF below per-vehicle floor");

        // Position grew on both sides
        assertGt(collateralPost, collateralPre, "collateral did not grow");
        assertGt(debtPost, debtPre, "debt did not appear");

        // Debt grew by more than the flash amount because the premium adds to debt. Measured on the
        // variable debt token, in USDC units: `getUserAccountData` reports the Aave base currency.
        assertGt(variableDebt.balanceOf(address(safe)) - variableDebtPre, FLASH_AMOUNT, "debt did not include premium");

        // (Invariant 6) Wallet balance unchanged — premium is absorbed into the borrow leg
        assertEq(IERC20(USDC).balanceOf(address(safe)), walletPre, "dust residual");

        _assertLoopHygiene();
    }

    // ==================== Repay ====================

    /// Repay via Morpho flash: flash-borrow USDC, repay Aave debt, withdraw collateral from
    /// Aave to repay the flash. Net: Safe deleverages by `FLASH_AMOUNT`.
    function test_repay_morphoFlash_usdcSameAsset() public {
        // Pre-condition: build a leveraged position via Boost so there is debt to repay.
        _runLoop(_morphoBoostParams());

        uint256 walletPre = IERC20(USDC).balanceOf(address(safe));
        (uint256 collateralPre, uint256 debtPre,,,,) = IPool(AAVE_V3_POOL).getUserAccountData(address(safe));
        assertGt(debtPre, 0, "pre-Repay debt should be non-zero");

        _runLoop(_morphoRepayParams());

        (uint256 collateralPost, uint256 debtPost,,,,) = IPool(AAVE_V3_POOL).getUserAccountData(address(safe));

        // Position shrank on both sides
        assertLt(collateralPost, collateralPre, "collateral did not shrink");
        assertLt(debtPost, debtPre, "debt did not shrink");

        // (Invariant 6) Wallet balance unchanged across the Repay
        assertEq(IERC20(USDC).balanceOf(address(safe)), walletPre, "dust residual");

        _assertLoopHygiene();
    }

    // ==================== Negative — HF floor ====================

    /// Setting `minHealthFactor` above any reachable post-loop HF must abort the loop.
    /// Validates invariant 5 (post-loop HF check) AND invariant 3 (atomic bracket): a revert
    /// after install / dispatch must leave the Safe in its pre-loop state — no leaked Module,
    /// no leaked fallback, no collateral / debt drift.
    function test_boost_morphoFlash_revertsWhenHfBelowFloor() public {
        uint256 walletPre = IERC20(USDC).balanceOf(address(safe));
        (uint256 collateralPre, uint256 debtPre,,,,) = IPool(AAVE_V3_POOL).getUserAccountData(address(safe));

        IFlashLoanHelper.LoopParams memory p = _morphoBoostParams();
        // Set the floor far above any reachable post-loop HF — the loop mechanically completes,
        // but the post-loop HF check trips and reverts with `HealthFactorTooLow`.
        p.minHealthFactor = 100e18;

        bytes memory cd = abi.encodeCall(IFlashLoanHelper.executeLoop, (p));

        // Safe.execTransaction propagates the inner Helper revert as `GS013` (the require gate
        // that fires when `execute` returns false and `safeTxGas + gasPrice == 0`). The inner
        // `HealthFactorTooLow` selector is lost across the delegatecall boundary (Safe's execute
        // uses 0-sized return-data window). We assert on the outer behaviour instead:
        // (1) the tx reverted, (2) Safe state is fully unchanged.
        vm.expectRevert();
        _execAsSafe(address(helper), cd, Enum.Operation.DelegateCall);

        // (Invariant 3) Atomic rollback — position unchanged
        (uint256 collateralPost, uint256 debtPost,,,,) = IPool(AAVE_V3_POOL).getUserAccountData(address(safe));
        assertEq(collateralPost, collateralPre, "collateral drifted despite revert");
        assertEq(debtPost, debtPre, "debt drifted despite revert");
        assertEq(IERC20(USDC).balanceOf(address(safe)), walletPre, "wallet drifted despite revert");

        // (Invariant 3) Atomic rollback — Safe-side bracket cleared
        _assertLoopHygiene();
    }

    // ==================== LoopParams builders ====================

    function _morphoBoostParams() internal pure returns (IFlashLoanHelper.LoopParams memory) {
        return IFlashLoanHelper.LoopParams({
            direction: IFlashLoanHelper.LoopDirection.Boost,
            lendingVenue: AAVE_V3_POOL,
            asset: USDC,
            flashAmount: FLASH_AMOUNT,
            flashVenue: MORPHO,
            flashVenueKind: IFlashLoanHelper.FlashVenueKind.Morpho,
            minHealthFactor: MIN_HF
        });
    }

    function _aaveBoostParams() internal pure returns (IFlashLoanHelper.LoopParams memory) {
        return IFlashLoanHelper.LoopParams({
            direction: IFlashLoanHelper.LoopDirection.Boost,
            lendingVenue: AAVE_V3_POOL,
            asset: USDC,
            flashAmount: FLASH_AMOUNT,
            flashVenue: AAVE_V3_POOL,
            flashVenueKind: IFlashLoanHelper.FlashVenueKind.Aave,
            minHealthFactor: MIN_HF
        });
    }

    function _morphoRepayParams() internal pure returns (IFlashLoanHelper.LoopParams memory) {
        return IFlashLoanHelper.LoopParams({
            direction: IFlashLoanHelper.LoopDirection.Repay,
            lendingVenue: AAVE_V3_POOL,
            asset: USDC,
            flashAmount: FLASH_AMOUNT,
            flashVenue: MORPHO,
            flashVenueKind: IFlashLoanHelper.FlashVenueKind.Morpho,
            // After a Repay, HF only goes up; floor here just verifies it's at least healthy.
            minHealthFactor: MIN_HF
        });
    }

    // ==================== Aave fork environment ====================

    /// @dev Make `asset` usable as collateral on the forked Aave pool. This suite tests the Helper's
    ///      loop mechanics, not Aave's risk parameters, so a reserve at LTV 0 is restored here, the
    ///      same way `deal` stands in for real balances. The test contract becomes RISK_ADMIN through
    ///      the ACL admin of the pool's addresses provider, then unfreezes the reserve if it is frozen
    ///      and restores Aave's pending LTV. Without a pending LTV, it sets the LTV
    ///      `FALLBACK_LTV_MARGIN` below the liquidation threshold. No-op when the LTV is non-zero.
    function _ensureCollateralLtv(address asset) internal {
        IPool pool = IPool(AAVE_V3_POOL);
        if (pool.getConfiguration(asset).getLtv() != 0) return;

        IPoolAddressesProvider provider = pool.ADDRESSES_PROVIDER();
        IPoolConfigurator configurator = IPoolConfigurator(provider.getPoolConfigurator());
        // Resolved before `vm.prank`: an external call left in the pranked statement would consume
        // the prank instead of `addRiskAdmin`.
        IACLManager acl = IACLManager(provider.getACLManager());
        address aclAdmin = provider.getACLAdmin();
        vm.prank(aclAdmin);
        acl.addRiskAdmin(address(this));

        if (pool.getConfiguration(asset).getFrozen()) configurator.setReserveFreeze(asset, false);

        if (configurator.getPendingLtv(asset) != 0) {
            configurator.setReserveLtvzero(asset, false);
        } else {
            DataTypes.ReserveConfigurationMap memory config = pool.getConfiguration(asset);
            uint256 liquidationThreshold = config.getLiquidationThreshold();
            assertGt(liquidationThreshold, FALLBACK_LTV_MARGIN, "asset is not collateral on Aave");
            configurator.configureReserveAsCollateral(
                asset, liquidationThreshold - FALLBACK_LTV_MARGIN, liquidationThreshold, config.getLiquidationBonus()
            );
        }

        assertGt(pool.getConfiguration(asset).getLtv(), 0, "Aave collateral LTV still 0");
    }

    // ==================== Common assertions / drivers ====================

    /// Drive `executeLoop` via `Safe.execTransaction(operation=DelegateCall, target=Helper)`.
    function _runLoop(IFlashLoanHelper.LoopParams memory p) internal {
        bytes memory cd = abi.encodeCall(IFlashLoanHelper.executeLoop, (p));
        _execAsSafe(address(helper), cd, Enum.Operation.DelegateCall);
    }

    /// (Invariants 3, 8.) After any successful `executeLoop`, the Safe must be back to a clean
    /// state: no fallback handler, Helper not enabled as a Module, owners + threshold unchanged.
    function _assertLoopHygiene() internal view {
        assertFalse(safe.isModuleEnabled(address(helper)), "Helper Module status leaked");
        bytes memory fbRaw = safe.getStorageAt(uint256(FALLBACK_HANDLER_SLOT), 1);
        assertEq(abi.decode(fbRaw, (address)), address(0), "fallback handler leaked");
        address[] memory ownersPost = safe.getOwners();
        assertEq(ownersPost.length, 1, "owners length changed");
        assertEq(ownersPost[0], address(this), "owner changed");
        assertEq(safe.getThreshold(), 1, "threshold changed");
    }

    /// Execute an action as the Safe using the pre-validated-signature path. Single-owner Safe
    /// with this contract as the owner: `v=1, r=owner-address` is accepted iff `msg.sender == owner`.
    function _execAsSafe(address to, bytes memory data, Enum.Operation op) internal {
        bytes memory sig = abi.encodePacked(
            bytes32(uint256(uint160(address(this)))), // r = owner address (left-padded)
            bytes32(uint256(0)), // s = 0
            uint8(1) // v = 1 (pre-validated)
        );
        safe.execTransaction(to, 0, data, op, 0, 0, 0, address(0), payable(address(0)), sig);
    }
}
