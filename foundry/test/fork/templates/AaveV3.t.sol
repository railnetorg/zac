// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IAaveV3Pool {
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);
    function setUserEMode(uint8 categoryId) external;
}

/// @title  AaveV3RoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/aave_v3/aave_v3.tmpl` policy.
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `policy.zac.yaml` fixture against the fresh Modifier. The
///         test functions assert the Modifier's allow/deny decision for token `approve`,
///         `borrow` / `repay` and `setUserEMode`. `RPC_URL` must be set.
contract AaveV3RoleMainnetTest is ZacForkTest {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    uint8 constant CALL = 0;

    // Policy-pinned values (mirror `policy.zac.yaml` + the template).
    uint256 constant VARIABLE_RATE = 2;
    uint256 constant STABLE_RATE = 1;
    uint16 constant REFERRAL = 0;
    uint256 constant AMOUNT = 1_000e6;
    uint8 constant EMODE_NONE = 0;

    /// @dev `encodeKey('AAVE_V3')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x414156455f563300000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "aave_v3.zac.yaml");
    }

    // ==================== Acceptance: allow ====================

    /// TF-1 — happy: a role member approves the Aave pool to pull USDC. The scoped spender is
    ///        the pool, so the call clears the policy and the Safe executes the approval.
    function test_TF1_RoleMemberCanApproveUSDCForPool() public {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr)
            .execTransactionWithRole(
                USDC, 0, abi.encodeCall(IERC20.approve, (AAVE_V3_POOL, 1_000_000)), CALL, ROLE_KEY, true
            );
        assertTrue(ok, "execTransactionWithRole returned false");
        assertEq(IERC20(USDC).allowance(safeAddr, AAVE_V3_POOL), 1_000_000, "Safe -> pool allowance did not update");
    }

    /// TF-3 — happy: borrow whitelisted asset, variable rate, onBehalfOf = Safe. `shouldRevert=false`
    ///        keeps this at the policy gate: the Safe has no collateral so the inner borrow fails,
    ///        but a policy rejection would surface as a `ConditionViolation` revert. No revert here
    ///        means the policy admitted the calldata. Loop execution is covered by the Helper test.
    function test_TF3_RoleMemberCanBorrowWhitelistedAsset() public {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                AAVE_V3_POOL,
                0,
                abi.encodeCall(IAaveV3Pool.borrow, (USDC, AMOUNT, VARIABLE_RATE, REFERRAL, safeAddr)),
                CALL,
                ROLE_KEY,
                false
            );
    }

    /// TF-4 — happy: repay whitelisted asset, variable rate, onBehalfOf = Safe. Gate-level
    ///        (`shouldRevert=false`); no debt exists, so only the policy decision is asserted.
    function test_TF4_RoleMemberCanRepayWhitelistedAsset() public {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                AAVE_V3_POOL,
                0,
                abi.encodeCall(IAaveV3Pool.repay, (USDC, AMOUNT, VARIABLE_RATE, safeAddr)),
                CALL,
                ROLE_KEY,
                false
            );
    }

    /// TF-5 — happy: setUserEMode at the configured category (0 = no E-Mode). With no debt this
    ///        executes on the fresh Safe; `shouldRevert=false` keeps the assertion at the policy gate.
    function test_TF5_RoleMemberCanSetConfiguredEMode() public {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                AAVE_V3_POOL, 0, abi.encodeCall(IAaveV3Pool.setUserEMode, (EMODE_NONE)), CALL, ROLE_KEY, false
            );
    }

    // ==================== Acceptance: deny (red-team) ====================

    /// TF-2 — sad: approving a non-pool spender is rejected (the scoped spender is the pool).
    function test_TF2_RoleMemberCannotApproveWrongSpender() public {
        expectPolicyReject(
            modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (address(0xdead), 1_000_000)), CALL, ROLE_KEY
        );
    }

    /// TF-6 — sad: borrow of an off-whitelist asset (config allows USDC only).
    function test_TF6_BorrowOffWhitelistAssetRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            AAVE_V3_POOL,
            abi.encodeCall(IAaveV3Pool.borrow, (WETH, AMOUNT, VARIABLE_RATE, REFERRAL, safeAddr)),
            CALL,
            ROLE_KEY
        );
    }

    /// TF-7 — sad: borrow onBehalfOf a third party (onBehalfOf is pinned to the avatar).
    function test_TF7_BorrowOnBehalfOfNonAvatarRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            AAVE_V3_POOL,
            abi.encodeCall(IAaveV3Pool.borrow, (USDC, AMOUNT, VARIABLE_RATE, REFERRAL, address(0xdead))),
            CALL,
            ROLE_KEY
        );
    }

    /// TF-8 — sad: borrow at stable rate (interestRateMode is pinned to 2 = variable).
    function test_TF8_BorrowStableRateRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            AAVE_V3_POOL,
            abi.encodeCall(IAaveV3Pool.borrow, (USDC, AMOUNT, STABLE_RATE, REFERRAL, safeAddr)),
            CALL,
            ROLE_KEY
        );
    }

    /// TF-9 — sad: setUserEMode at a category other than the configured one (0).
    function test_TF9_SetUnconfiguredEModeRejected() public {
        expectPolicyReject(
            modAddr, ALICE, AAVE_V3_POOL, abi.encodeCall(IAaveV3Pool.setUserEMode, (uint8(1))), CALL, ROLE_KEY
        );
    }
}
