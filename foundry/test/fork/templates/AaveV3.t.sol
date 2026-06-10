// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title  AaveV3RoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/aave_v3/aave_v3.tmpl` policy.
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `policy.zac.yaml` fixture against the fresh Modifier. The
///         test functions assert the Modifier's allow/deny decision for token `approve`.
///         `RPC_URL` must be set.
contract AaveV3RoleMainnetTest is ZacForkTest {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    uint8 constant CALL = 0;

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

    /// TF-2 — sad: approving a non-pool spender is rejected (the scoped spender is the pool).
    function test_TF2_RoleMemberCannotApproveWrongSpender() public {
        expectPolicyReject(
            modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (address(0xdead), 1_000_000)), CALL, ROLE_KEY
        );
    }
}
