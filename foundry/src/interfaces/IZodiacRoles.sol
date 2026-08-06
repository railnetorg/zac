// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  IZodiacRoles
/// @notice Zodiac Roles v2 Modifier surface used by `SyrupNavManager`.
/// @dev    The manager holds a role on the modifier and routes every value-moving call through it, so the
///         zac-generated policy re-checks each target and parameter even if the manager is buggy.
///
///         `operation` follows Safe's `Enum.Operation`: 0 == CALL, 1 == DELEGATECALL. The manager only ever
///         issues CALL; it never delegatecalls from the Safe.
interface IZodiacRoles {
    /// @notice Executes a transaction from the avatar (the Safe) under a specific role.
    /// @param to The call target.
    /// @param value The native value to forward.
    /// @param data The calldata to execute.
    /// @param operation Safe operation type: 0 == CALL, 1 == DELEGATECALL.
    /// @param roleKey The role to execute under.
    /// @param shouldRevert Whether an inner failure should bubble up as a revert.
    /// @return success Whether the inner call succeeded.
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool success);

    /// @notice The account the modifier executes on behalf of -- the Safe holding the strategy's assets.
    /// @return avatar The avatar address.
    function avatar() external view returns (address avatar);
}
