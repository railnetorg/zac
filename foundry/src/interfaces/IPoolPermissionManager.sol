// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  IPoolPermissionManager
/// @notice The single read of Maple's `MaplePoolPermissionManager` this integration needs.
///
/// @dev    Used only to tell two indistinguishable zero returns apart. `Pool.maxDeposit` returns 0 both when
///         the receiver lacks `P:deposit` permission and when the pool is at its liquidity cap, and never
///         reverts -- but the operational remedies are completely different: one is a call to Maple's
///         onboarding desk, the other is waiting for capacity.
///
///         syrupUSDC runs at `permissionLevel == 1` (FUNCTION_LEVEL), where {hasPermission} resolves as:
///         allow if the pool is PUBLIC, else allow if `lenderAllowlist[poolManager][lender]`, else deny if the
///         pool is PRIVATE, else allow iff `(poolBitmap & lenderBitmap) == poolBitmap` for that function id.
///         A zero pool bitmap therefore makes a function permissionless for everyone.
///
///         Being on `lenderAllowlist` short-circuits before any bitmap is read, so it is the only
///         configuration robust to Maple changing a bitmap later. That is what the Safe should hold.
interface IPoolPermissionManager {
    /// @notice Whether `lender` may call the function identified by `functionId` on `poolManager`'s pool.
    /// @param poolManager The Maple pool manager.
    /// @param lender The address being checked.
    /// @param functionId Maple's ASCII function identifier, e.g. `bytes32("P:deposit")`.
    /// @return allowed True when the call is permitted.
    function hasPermission(address poolManager, address lender, bytes32 functionId) external view returns (bool allowed);
}
