// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  IRoleRegistry
/// @notice The external role registry `SyrupNavManager` consults for its keeper and guardian roles.
///
/// @dev    Deliberately narrow. The manager is immutable, so rotating an operator key must not require a
///         redeployment: roles live in a registry the manager only ever reads, and the registry's own admin
///         grants and revokes them. This is the manager's single upgrade path.
///
///         The signature matches Railnet's `ExternalAccessControl` (in the `hangar` repo) exactly, so that
///         contract can serve as the registry in production with no adapter. `scope` namespaces a role to one
///         consumer, letting a single registry serve many managers without a grant on one leaking to another;
///         the manager always passes its own address.
interface IRoleRegistry {
    /// @notice Whether `account` holds `role`, either globally or scoped to `scope`.
    /// @param role The role identifier.
    /// @param scope The consumer the role may be scoped to.
    /// @param account The account to check.
    /// @return held True if the account holds the role globally or for this scope.
    function hasRoleOrScopedRole(bytes32 role, address scope, address account) external view returns (bool held);
}
