// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  ISyrupWithdrawalManager
/// @notice Minimal view of `MapleWithdrawalManager` (the queue manager, **v2.0.0**) used by the public Syrup
///         pools. Requests are appended to a single global FIFO queue and serviced by the pool delegate.
///
/// @dev    Pinned to the deployed version. syrupUSDC's withdrawal manager
///         (`0x1bc47a0Dd0FdaB96E9eF982fdf1F34DC6207cfE3`) runs `withdrawal-manager-queue` v2.0.0, which
///         differs from v1.0.0 in ways this integration depends on:
///
///         - v1 stored `mapping(address => uint128) public requestIds` and rejected a second concurrent
///           request per owner (`WM:AS:IN_QUEUE`). v2 removed that limit: an owner may hold arbitrarily many
///           requests, and `requestIds` became a *derived* view over a sorted linked list of all of them.
///         - v1's `removeShares` acted on that single stored entry. v2 walks the owner's requests LIFO across
///           as many entries as needed, bounded by {userEscrowedShares}. An integration that reasons about
///           "only the latest entry is cancellable" is therefore wrong against the deployed contract, which is
///           why this integration cancels through {removeSharesById} instead.
///         - v2 added {removeSharesById}, {requestsByOwner}, {userEscrowedShares} and {lockedShares}.
interface ISyrupWithdrawalManager {
    /// @notice The owner's highest still-open queued request id, or 0 when the owner has none open.
    /// @dev Derived from the owner's request list (`SortedLinkedList.getLast`), so it is never stale. Ids are
    ///      minted `++queue.lastRequestId` and strictly increasing, so a fresh request is always the highest.
    ///      It reveals only the newest of several concurrent requests -- use {requestsByOwner} for the full
    ///      set. This integration records ids as it creates them and never depends on this getter for
    ///      accounting; it is exposed for observability only.
    /// @param owner The address that requested the withdrawal.
    /// @return requestId The owner's highest open request id, 0 when nothing is outstanding.
    function requestIds(address owner) external view returns (uint256 requestId);

    /// @notice A queued withdrawal request.
    /// @dev `shares` shrinks in place, under the same id, as the pool delegate partially services the request;
    ///      the entry is zeroed once fully processed or removed. Ids are never reused, so a tracked id can
    ///      never be reassigned to a different owner.
    /// @param requestId The queue entry to read.
    /// @return owner The requester, address(0) once the entry is cleared.
    /// @return shares The pool shares still awaiting service for this request.
    function requests(uint256 requestId) external view returns (address owner, uint256 shares);

    /// @notice Every open request of `owner`, oldest first.
    /// @param owner The address that requested the withdrawals.
    /// @return requestIds_ The open request ids.
    /// @return shares The remaining shares of each corresponding request.
    function requestsByOwner(address owner)
        external
        view
        returns (uint256[] memory requestIds_, uint256[] memory shares);

    /// @notice The total shares `owner` has escrowed across every open request.
    /// @param owner The address that requested the withdrawals.
    /// @return shares The owner's total escrowed shares.
    function userEscrowedShares(address owner) external view returns (uint256 shares);

    /// @notice Shares already serviced into `owner`'s manual bucket but not yet redeemed.
    /// @dev Non-zero only while `isManualWithdrawal[owner]` is set. In that state the delegate's
    ///      `processRedemptions` deletes the queue entry **without moving assets**: the pool shares stay on the
    ///      withdrawal manager and the owner must call `pool.redeem` to collect. Such shares are therefore
    ///      invisible to the Safe's balance, invisible to {requests}, and would vanish from a NAV built from
    ///      those two alone -- which is why `SyrupNavManager` values them as a fourth term.
    /// @param owner The share owner.
    /// @return shares The shares awaiting a manual redeem.
    function lockedShares(address owner) external view returns (uint256 shares);

    /// @notice Whether the delegate has flagged `owner` for manual withdrawal.
    /// @dev Settable by the pool delegate or operational admin at any time, including while requests are open
    ///      -- v2.0.0 dropped v1's `requestIds[owner] == 0` precondition. Read as an observability signal; the
    ///      valuation does not branch on it, it values {lockedShares} unconditionally.
    /// @param owner The share owner.
    /// @return isManual True when the owner is flagged for manual withdrawal.
    function isManualWithdrawal(address owner) external view returns (bool isManual);

    /// @notice Cancels an exact amount from an exact queue entry, returning the shares to its owner.
    /// @dev Unprivileged and owner-authenticated (`require(request.owner == msg.sender)`), and the reason this
    ///      integration cancels here rather than through `Pool.removeShares`. Two consequences: any tracked
    ///      request is cancellable rather than only the newest, and the call does not pass through
    ///      `MaplePool.checkCall`, so it is not gated on the pool's `P:removeShares` permission -- which for
    ///      syrupUSDC carries the same bitmap as `P:deposit`, and would otherwise make cancellation fail
    ///      exactly when Maple has revoked the Safe's deposit rights.
    /// @param requestId The queue entry to reduce.
    /// @param sharesToRemove The shares to remove from it.
    /// @return sharesReturned The shares returned to the owner.
    /// @return sharesRemaining The shares still queued under that id afterwards.
    function removeSharesById(uint256 requestId, uint256 sharesToRemove)
        external
        returns (uint256 sharesReturned, uint256 sharesRemaining);
}
