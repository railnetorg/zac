// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ZacForkTest} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IRolesModifier {
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool);
}

/// @dev Exercises the Sepolia AAVE V3 role config. Forks Sepolia, applies the
///      ZAC config via the inherited helper, then asserts that a role member
///      can perform a scoped call and is blocked on an out-of-scope call.
contract AaveV3SepoliaTest is ZacForkTest {
    address constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address constant AAVE_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address constant SAFE = 0x94656Ee1C3256c08C9dcBA28dB5A3703643256b1;
    address constant MODIFIER = 0x18f891a737723E5aaB623DccD922AEB6180F2337;
    address constant MEMBER = 0x7FD6E72d8d48f82B9E808eB81673129B1496168A;

    // SDK encodeKey('AAVE_V3') = right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x414156455f563300000000000000000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        zacApply("../examples/sepolia/aave_safe.yaml");
    }

    /// @notice TF-1 — happy: a role member can call USDC.approve(pool, _) via
    ///         execTransactionWithRole. The scoped spender is the AAVE pool.
    function test_TF1_RoleMemberCanApproveUSDCForPool() public {
        vm.startPrank(MEMBER);
        bool ok = IRolesModifier(MODIFIER)
            .execTransactionWithRole(
                USDC, 0, abi.encodeWithSelector(IERC20.approve.selector, AAVE_POOL, 1_000_000), 0, ROLE_KEY, true
            );
        vm.stopPrank();
        assertTrue(ok, "execTransactionWithRole returned false");
        assertEq(IERC20(USDC).allowance(SAFE, AAVE_POOL), 1_000_000, "Safe -> pool allowance did not update");
    }

    /// @notice TF-2 — fail: a role member trying to approve a non-pool spender
    ///         is rejected by the modifier (scoped spender must == AAVE_POOL).
    function test_TF2_RoleMemberCannotApproveWrongSpender() public {
        vm.startPrank(MEMBER);
        vm.expectRevert();
        IRolesModifier(MODIFIER)
            .execTransactionWithRole(
                USDC, 0, abi.encodeWithSelector(IERC20.approve.selector, address(0xdead), 1_000_000), 0, ROLE_KEY, true
            );
        vm.stopPrank();
    }
}
