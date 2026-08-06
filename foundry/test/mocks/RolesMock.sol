// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {SafeMock} from "./SafeMock.sol";

/// @title  RolesMock
/// @notice Minimal Zodiac Roles v2 Modifier.
/// @dev    Models the three properties the NAV manager relies on: the modifier exposes an `avatar`, it checks
///         that the caller holds the role key, and it executes through the Safe so the target sees the Safe as
///         `msg.sender`. Target and parameter scoping is out of scope here -- that is the zac policy's job, and
///         the manager is written not to depend on it.
contract RolesMock {
    SafeMock public safeAvatar;

    /// @dev roleKey => member => granted.
    mapping(bytes32 => mapping(address => bool)) public members;

    /// @dev Simulates a policy rejection for a given target, so the manager's failure handling is testable.
    mapping(address => bool) public blockedTargets;

    /// @dev When true, `execTransactionWithRole` reports `false` without touching the Safe. The real modifier
    ///      reverts instead, but the manager keeps a `SafeExecutionFailed` guard for the case where it does not,
    ///      and that guard is only reachable through this.
    bool public forceFailure;

    error NotAuthorized(address caller, bytes32 roleKey);
    error TargetBlockedByPolicy(address target);

    constructor(SafeMock safe_) {
        safeAvatar = safe_;
    }

    function assignRole(bytes32 roleKey_, address member_) external {
        members[roleKey_][member_] = true;
    }

    function revokeRole(bytes32 roleKey_, address member_) external {
        members[roleKey_][member_] = false;
    }

    function setBlockedTarget(address target_, bool blocked_) external {
        blockedTargets[target_] = blocked_;
    }

    function setForceFailure(bool forceFailure_) external {
        forceFailure = forceFailure_;
    }

    function execTransactionWithRole(
        address to_,
        uint256 value_,
        bytes calldata data_,
        uint8 operation_,
        bytes32 roleKey_,
        bool shouldRevert_
    ) external returns (bool success) {
        if (!members[roleKey_][msg.sender]) revert NotAuthorized(msg.sender, roleKey_);
        if (blockedTargets[to_]) revert TargetBlockedByPolicy(to_);
        if (forceFailure) return false;

        success = safeAvatar.execTransactionFromModule(to_, value_, data_, operation_);

        if (!success && shouldRevert_) {
            revert TargetBlockedByPolicy(to_);
        }
    }

    function avatar() external view returns (address) {
        return address(safeAvatar);
    }
}
