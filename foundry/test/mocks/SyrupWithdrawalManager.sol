// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMaplePool} from "src/interfaces/IMaplePool.sol";

/// @notice A queued withdrawal request.
struct WithdrawalRequest {
    address owner;
    uint256 shares;
}

/// @notice The FIFO queue of withdrawal requests.
struct Queue {
    uint128 nextRequestId; // Identifier of the next request that will be processed.
    uint128 lastRequestId; // Identifier of the last created request.
    mapping(uint128 => WithdrawalRequest) requests; // Maps withdrawal requests to their positions in the queue.
}

/// @title  SyrupWithdrawalManager
/// @notice `MapleWithdrawalManager` **v2.0.0** (the queue manager) simplified for testing.
/// @dev    Reproduces the queue behaviours the NAV manager is built around:
///
///         (1) an owner may hold SEVERAL concurrent requests, each with its own strictly-increasing id;
///         (2) `$requestIds[owner]` reports the owner's HIGHEST open id, and is cleared only when it still
///             points at the request being removed -- so an owner with several queued requests keeps a
///             non-zero pointer until the last of them is gone;
///         (3) a request can be serviced only in part, shrinking `shares` in place and leaving it queued;
///         (4) {removeSharesById} cancels an exact amount from an exact id, unprivileged and
///             owner-authenticated -- the primitive `SyrupNavManager.cancelRedeem` uses;
///         (5) **manual withdrawal.** While `$isManualWithdrawal[owner]` is set, processing a request deletes
///             its queue entry but moves no assets: the shares are credited to `$manualSharesAvailable[owner]`
///             and the pool tokens stay here until the owner redeems them. This is the state that makes a
///             three-term NAV crater, and the reason the manager values {lockedShares} as a fourth term.
///
///         Deliberately NOT modelled: the exact internal call routing Maple uses for a manual exit. What is
///         modelled is the observable contract the manager depends on -- `lockedShares` falls and the owner's
///         assets rise. `test/fork/SyrupNavManagerFork.t.sol` is the authority on the real wiring.
contract SyrupWithdrawalManager {
    using SafeERC20 for ERC20;

    address public $pool;
    address public $poolManager;
    uint256 public $totalShares; // Total amount of shares pending redemption.
    Queue public $queue;
    // Maps users to their HIGHEST open withdrawal request identifier. The queue manager allows an owner to hold
    // several concurrent requests, so this is a pointer to the newest one, not a one-request lock.
    mapping(address => uint256) public $requestIds;
    // Total shares an owner has escrowed across every open request. The bound `removeShares` checks against.
    mapping(address => uint256) public $userEscrowedShares;
    // Shares processed into an owner's manual bucket, awaiting an explicit redeem.
    mapping(address => uint256) public $manualSharesAvailable;
    // Whether the delegate has flagged an owner for manual withdrawal. v2.0.0 allows toggling this while the
    // owner has open requests, which v1.0.0 did not.
    mapping(address => bool) public $isManualWithdrawal;
    // The ids of an owner's open requests, oldest first.
    mapping(address => uint256[]) private $ownerRequests;

    error Err(string message);

    constructor(address pool_, address poolManager_) {
        if (pool_ == address(0)) revert Err("ZERO_POOL");
        if (poolManager_ == address(0)) revert Err("ZERO_POOL_MANAGER");

        $pool = pool_;
        $poolManager = poolManager_;
    }

    /// @dev Mirrors v2.0.0's `addShares`: an owner may hold several concurrent requests, each getting its own
    ///      queue entry and strictly-increasing id, and `$requestIds` tracks the newest of them. There is no
    ///      branch that redeems, so a queue entry always survives a successful call -- servicing only ever
    ///      happens later, when the delegate calls {processRedemptions}.
    function addShares(uint256 shares_, address owner_) external returns (uint256 lastRequestId) {
        if (shares_ == 0) revert Err("WM:AS:ZERO_SHARES");

        uint128 lastRequestId_ = ++$queue.lastRequestId;

        $queue.requests[lastRequestId_] = WithdrawalRequest({owner: owner_, shares: shares_});

        $requestIds[owner_] = lastRequestId_;
        $ownerRequests[owner_].push(lastRequestId_);
        $userEscrowedShares[owner_] += shares_;

        // Increase the number of shares locked.
        $totalShares += shares_;

        ERC20($pool).safeTransferFrom(msg.sender, address(this), shares_);

        return lastRequestId_;
    }

    /// @dev Mirrors v2.0.0's `setManualWithdrawal`, which -- unlike v1.0.0 -- has no precondition that the
    ///      owner hold no open requests. Callable by the pool delegate or operational admin on mainnet.
    function setManualWithdrawal(address owner_, bool isManual_) external {
        $isManualWithdrawal[owner_] = isManual_;
    }

    /// @dev Mirrors v2.0.0's `removeShares`: walks the owner's requests LIFO across as many entries as needed,
    ///      bounded by the owner's TOTAL escrow rather than by the newest entry. All-or-nothing.
    function removeShares(uint256 shares_, address owner_) external returns (uint256 sharesReturned) {
        if (shares_ == 0) revert Err("WM:RS:ZERO_SHARES");
        if ($userEscrowedShares[owner_] < shares_) revert Err("WM:RS:INSUFFICIENT_SHARES");

        while (sharesReturned < shares_) {
            uint128 requestId_ = uint128($requestIds[owner_]);
            WithdrawalRequest memory request_ = $queue.requests[requestId_];
            uint256 toRemove_ = shares_ - sharesReturned < request_.shares ? shares_ - sharesReturned : request_.shares;
            sharesReturned += _removeShares(requestId_, toRemove_, owner_, request_.shares);
        }

        return sharesReturned;
    }

    /// @dev v2.0.0's precise cancellation primitive: unprivileged, owner-authenticated, exact by id. Not gated
    ///      on the pool's `P:removeShares` permission, because it never passes through `MaplePool.checkCall`.
    function removeSharesById(uint256 requestId_, uint256 sharesToRemove_)
        external
        returns (uint256 sharesReturned, uint256 sharesRemaining)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        WithdrawalRequest memory request_ = $queue.requests[uint128(requestId_)];

        if (request_.owner == address(0)) revert Err("WM:RSBI:INVALID_REQUEST");
        if (request_.owner != msg.sender) revert Err("WM:RSBI:NOT_OWNER");
        if (sharesToRemove_ == 0) revert Err("WM:RSBI:NO_CHANGE");
        if (sharesToRemove_ > request_.shares) revert Err("WM:RSBI:INSUFFICIENT_SHARES");

        // forge-lint: disable-next-line(unsafe-typecast)
        sharesReturned = _removeShares(uint128(requestId_), sharesToRemove_, request_.owner, request_.shares);
        sharesRemaining = request_.shares - sharesToRemove_;
    }

    function processRedemptions(uint256 maxSharesToProcess_) external {
        if (maxSharesToProcess_ == 0) revert Err("ZERO_MAX_SHARES");

        (uint256 redeemableShares_,) = _calculateRedemption(maxSharesToProcess_);

        // Revert if there are insufficient assets to redeem any shares.
        if (redeemableShares_ == 0) {
            revert Err("INSUFFICIENT_LIQUIDITY");
        }

        _processQueue(redeemableShares_);
    }

    /// @dev The manual-exit counterpart of {processExit}: consumes the owner's manual bucket rather than a
    ///      queue entry. Called by the pool manager when the owner redeems for itself.
    function processManualExit(uint256 shares_, address owner_)
        external
        returns (uint256 redeemableShares_, uint256 resultingAssets_)
    {
        if (msg.sender != $poolManager) revert Err("WM:PME:NOT_PM");
        uint256 available_ = $manualSharesAvailable[owner_];
        if (shares_ == 0 || shares_ > available_) revert Err("WM:PME:INVALID_SHARES");

        $manualSharesAvailable[owner_] = available_ - shares_;
        $totalShares -= shares_;

        (redeemableShares_, resultingAssets_) = _calculateRedemption(shares_);
        if (redeemableShares_ != shares_) revert Err("WM:PME:LOW_LIQUIDITY");
    }

    function processExit(uint256 shares_, address)
        external
        view
        returns (uint256 redeemableShares_, uint256 resultingAssets_)
    {
        return _calculateRedemption(shares_);
    }

    function requestIds(address owner_) external view returns (uint256) {
        return $requestIds[owner_];
    }

    /// @dev A queued request. Zeroed once fully processed; `shares` shrinks in place on a partial fill.
    function requests(uint256 requestId_) external view returns (address owner_, uint256 shares_) {
        // casting to 'uint128' is safe because queue ids are minted as uint128, so any id above that range
        // cannot correspond to an existing request; the widened parameter only matches the real V2 ABI.
        // forge-lint: disable-next-line(unsafe-typecast)
        WithdrawalRequest memory request_ = $queue.requests[uint128(requestId_)];
        return (request_.owner, request_.shares);
    }

    /// @dev v2.0.0 only. Every open request of an owner, oldest first -- the correct way to enumerate
    ///      concurrent requests, and what makes v1's "attribution is lost" problem a non-problem.
    function requestsByOwner(address owner_)
        external
        view
        returns (uint256[] memory requestIds_, uint256[] memory shares_)
    {
        uint256[] memory ids_ = $ownerRequests[owner_];
        uint256 live_;
        for (uint256 idx_ = 0; idx_ < ids_.length; ++idx_) {
            // forge-lint: disable-next-line(unsafe-typecast)
            if ($queue.requests[uint128(ids_[idx_])].owner == owner_) ++live_;
        }
        requestIds_ = new uint256[](live_);
        shares_ = new uint256[](live_);
        uint256 cursor_;
        for (uint256 idx_ = 0; idx_ < ids_.length; ++idx_) {
            // forge-lint: disable-next-line(unsafe-typecast)
            WithdrawalRequest memory request_ = $queue.requests[uint128(ids_[idx_])];
            if (request_.owner != owner_) continue;
            requestIds_[cursor_] = ids_[idx_];
            shares_[cursor_] = request_.shares;
            ++cursor_;
        }
    }

    /// @dev v2.0.0 only. Total shares the owner has escrowed across every open request.
    function userEscrowedShares(address owner_) external view returns (uint256) {
        return $userEscrowedShares[owner_];
    }

    /// @dev v2.0.0 only. Shares already serviced into the owner's manual bucket, awaiting an explicit redeem.
    ///      The fourth NAV term.
    function lockedShares(address owner_) external view returns (uint256) {
        return $manualSharesAvailable[owner_];
    }

    /// @dev Whether the delegate has flagged this owner for manual withdrawal.
    function isManualWithdrawal(address owner_) external view returns (bool) {
        return $isManualWithdrawal[owner_];
    }

    function _processQueue(uint256 redeemableShares_) internal {
        uint128 nextRequestId_ = $queue.nextRequestId;
        uint128 lastRequestId_ = $queue.lastRequestId;

        // Use the redeemable shares as the amount to process
        uint256 sharesToProcess_ = redeemableShares_;

        // Iterate through the loop and process as many requests as possible.
        // Stop iterating when there are no more shares to process or if you have reached the end of the queue.
        while (sharesToProcess_ > 0 && nextRequestId_ <= lastRequestId_) {
            (uint256 sharesProcessed_, bool isProcessed_) = _processRequest(nextRequestId_, sharesToProcess_);

            // If the request has not been processed keep it at the start of the queue.
            // This request will be next in line to be processed on the next call.
            if (!isProcessed_) break;

            sharesToProcess_ -= sharesProcessed_;

            ++nextRequestId_;
        }

        // Adjust the new start of the queue.
        $queue.nextRequestId = nextRequestId_;
    }

    function _processRequest(uint128 requestId_, uint256 maximumSharesToProcess_)
        internal
        returns (uint256 processedShares_, bool isProcessed_)
    {
        WithdrawalRequest memory request_ = $queue.requests[requestId_];

        // If the request has already been cancelled, skip it.
        if (request_.owner == address(0)) return (0, true);

        // Process only up to the maximum amount of shares.
        uint256 sharesToProcess_ = request_.shares > maximumSharesToProcess_ ? maximumSharesToProcess_ : request_.shares;

        // Calculate how many shares can actually be redeemed.
        uint256 resultingAssets_;

        (processedShares_, resultingAssets_) = _calculateRedemption(sharesToProcess_);

        // If there are no remaining shares, request has been fully processed.
        isProcessed_ = (request_.shares - processedShares_) == 0;

        // If the request has been fully processed, remove it from the queue.
        if (isProcessed_) {
            _removeRequest(request_.owner, requestId_);
        } else {
            // Update the withdrawal request.
            $queue.requests[requestId_].shares = request_.shares - processedShares_;
        }
        $userEscrowedShares[request_.owner] -= processedShares_;

        // The manual branch is the dangerous one: the entry is gone but no assets move and the pool tokens stay
        // on this contract, credited to the owner's manual bucket.
        if ($isManualWithdrawal[request_.owner]) {
            $manualSharesAvailable[request_.owner] += processedShares_;
        } else {
            $totalShares -= processedShares_;
            IMaplePool($pool).redeem(processedShares_, request_.owner, address(this));
        }
    }

    /// @dev Removes shares from one entry, returning them to the owner. Deletes the entry when it empties.
    function _removeShares(uint128 requestId_, uint256 sharesToRemove_, address owner_, uint256 requestShares_)
        internal
        returns (uint256 sharesReturned_)
    {
        uint256 remaining_ = requestShares_ - sharesToRemove_;

        if (remaining_ == 0) {
            _removeRequest(owner_, requestId_);
        } else {
            $queue.requests[requestId_].shares = remaining_;
        }

        $userEscrowedShares[owner_] -= sharesToRemove_;
        $totalShares -= sharesToRemove_;
        ERC20($pool).safeTransfer(owner_, sharesToRemove_);

        return sharesToRemove_;
    }

    /// @dev Clears the owner's pointer only when it still points at the request being removed, so an owner with
    ///      several queued requests keeps a non-zero pointer until the last of them is gone. Then repoints it at
    ///      the highest surviving id, matching v2.0.0's derived `getLast` semantics.
    function _removeRequest(address owner_, uint128 requestId_) internal {
        delete $queue.requests[requestId_];

        uint256[] storage ids_ = $ownerRequests[owner_];
        uint256 highest_;
        for (uint256 idx_ = 0; idx_ < ids_.length; ++idx_) {
            uint256 id_ = ids_[idx_];
            if (id_ == requestId_) continue;
            // forge-lint: disable-next-line(unsafe-typecast)
            if ($queue.requests[uint128(id_)].owner != owner_) continue;
            if (id_ > highest_) highest_ = id_;
        }
        $requestIds[owner_] = highest_;
    }

    function _calculateRedemption(uint256 sharesToRedeem_)
        internal
        view
        returns (uint256 redeemableShares_, uint256 resultingAssets_)
    {
        // Prices with the same haircut the pool applies on exit, matching Maple's own payout formula.
        uint256 requiredLiquidity_ = IMaplePool($pool).convertToExitAssets(sharesToRedeem_);
        uint256 availableLiquidity_ = ERC20(IMaplePool($pool).asset()).balanceOf(address($pool));

        bool partialLiquidity_ = availableLiquidity_ < requiredLiquidity_;

        redeemableShares_ =
            partialLiquidity_ ? sharesToRedeem_ * availableLiquidity_ / requiredLiquidity_ : sharesToRedeem_;

        resultingAssets_ = IMaplePool($pool).convertToExitAssets(redeemableShares_);
    }
}
