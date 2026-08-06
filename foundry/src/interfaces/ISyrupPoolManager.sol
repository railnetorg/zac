// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  ISyrupPoolManager
/// @notice Maple pool manager surface used to resolve the pool's withdrawal manager.
/// @dev    Resolved on every read rather than cached: the pool delegate can rotate the withdrawal manager, and
///         a stale address would silently value the wrong queue.
interface ISyrupPoolManager {
    /// @notice The pool's current withdrawal manager.
    /// @return withdrawalManager The withdrawal manager address.
    function withdrawalManager() external view returns (address withdrawalManager);
}
