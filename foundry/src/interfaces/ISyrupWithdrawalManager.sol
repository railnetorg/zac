// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  ISyrupWithdrawalManager
/// @notice Minimal view of `MapleWithdrawalManagerQueue` (the "V2" withdrawal manager) used by the public Syrup
///         pools. Requests are appended to a single global FIFO queue and serviced by the pool delegate.
/// @dev    Unlike the cyclical V1 manager, the queue manager accepts several concurrent requests from the same
///         owner: each `requestRedeem` appends its own queue entry carrying its own id. `SyrupNavManager`
///         therefore records ids as it creates them and reads status per id, rather than relying on
///         `requestIds` after the fact.
interface ISyrupWithdrawalManager {
    /// @notice The owner's most recent queued withdrawal request id, or 0 once every request of theirs has been
    ///         fully serviced.
    /// @dev Only unambiguous in the transaction that created the request. It is also what Maple's
    ///      `removeShares` resolves a cancellation through, which is why only the latest entry is cancellable.
    /// @param owner The address that requested the withdrawal.
    /// @return requestId The owner's latest queued request id, 0 when nothing is outstanding.
    function requestIds(address owner) external view returns (uint256 requestId);

    /// @notice A queued withdrawal request.
    /// @dev `shares` shrinks as the pool delegate partially services the request; the entry is zeroed once it is
    ///      fully processed (or removed by the pool delegate).
    /// @param requestId The queue entry to read.
    /// @return owner The requester, address(0) once the entry is cleared.
    /// @return shares The pool shares still awaiting service for this request.
    function requests(uint256 requestId) external view returns (address owner, uint256 shares);
}
