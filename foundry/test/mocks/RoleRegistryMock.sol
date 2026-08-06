// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRoleRegistry} from "src/interfaces/IRoleRegistry.sol";

/// @title  RoleRegistryMock
/// @notice Minimal `IRoleRegistry` for tests: grants and revokes both global and scoped roles.
/// @dev    Railnet's `ExternalAccessControl` fills this seat in production. The mock keeps the same two-tier
///         semantics -- a global grant satisfies any scope, a scoped grant satisfies only its own -- so the
///         manager's role checks are exercised the way they will behave against the real registry.
contract RoleRegistryMock is IRoleRegistry {
    mapping(bytes32 => mapping(address => bool)) public globalRoles;
    mapping(bytes32 => mapping(address => mapping(address => bool))) public scopedRoles;

    function grantRole(bytes32 role, address account) external {
        globalRoles[role][account] = true;
    }

    function revokeRole(bytes32 role, address account) external {
        globalRoles[role][account] = false;
    }

    function grantScopedRole(bytes32 role, address scope, address account) external {
        scopedRoles[role][scope][account] = true;
    }

    function revokeScopedRole(bytes32 role, address scope, address account) external {
        scopedRoles[role][scope][account] = false;
    }

    /// @inheritdoc IRoleRegistry
    function hasRoleOrScopedRole(bytes32 role, address scope, address account)
        external
        view
        override
        returns (bool held)
    {
        return globalRoles[role][account] || scopedRoles[role][scope][account];
    }
}
