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
/// @notice `MapleWithdrawalManagerQueue` (the "V2" withdrawal manager) simplified for testing.
/// @dev    Reproduces the three queue behaviours the NAV manager is built around:
///
///         (1) an owner may hold SEVERAL concurrent requests, each with its own id;
///         (2) `$requestIds[owner]` points only at the owner's LATEST request, and is cleared only when it
///             still points at the request being removed -- so an owner with several queued requests keeps a
///             non-zero pointer until the last of them is serviced;
///         (3) a request can be serviced only in part, shrinking `shares` in place and leaving it queued.
contract SyrupWithdrawalManager {
    using SafeERC20 for ERC20;

    address public $pool;
    address public $poolManager;
    uint256 public $totalShares; // Total amount of shares pending redemption.
    Queue public $queue;
    // Maps users to their LATEST withdrawal request identifier. The queue manager allows an owner to hold
    // several concurrent requests, so this is a pointer to the most recent one, not a one-request lock.
    mapping(address => uint256) public $requestIds;
    // When true, `addShares` services the queue immediately, simulating Maple's instant-liquidity buffer.
    bool public $autoProcess;

    error Err(string message);

    constructor(address pool_, address poolManager_) {
        if (pool_ == address(0)) revert Err("ZERO_POOL");
        if (poolManager_ == address(0)) revert Err("ZERO_POOL_MANAGER");

        $pool = pool_;
        $poolManager = poolManager_;
    }

    /// @dev Mirrors MapleWithdrawalManagerQueue: an owner may hold several concurrent requests, each getting its
    ///      own queue entry and id, and `$requestIds` tracks the latest of them.
    function addShares(uint256 shares_, address owner_) external returns (uint256 lastRequestId) {
        if (shares_ == 0) revert Err("ZERO_SHARES");

        uint128 lastRequestId_ = ++$queue.lastRequestId;

        $queue.requests[lastRequestId_] = WithdrawalRequest({owner: owner_, shares: shares_});

        $requestIds[owner_] = lastRequestId_;

        // Increase the number of shares locked.
        $totalShares += shares_;

        ERC20($pool).safeTransferFrom(msg.sender, address(this), shares_);

        // Maple's public pools run an instant-liquidity buffer, so a request can be serviced inside the very
        // transaction that creates it -- leaving no queue entry and a zero `requestIds` pointer. Opt-in so a
        // test can exercise that path.
        if ($autoProcess) {
            (uint256 redeemable_,) = _calculateRedemption(shares_);
            if (redeemable_ > 0) _processQueue(redeemable_);
        }

        return lastRequestId_;
    }

    function setAutoProcess(bool autoProcess_) external {
        $autoProcess = autoProcess_;
    }

    /// @dev Mirrors `MapleWithdrawalManagerQueue.removeShares`: the queue manager takes an owner and no id, so
    ///      it resolves the removal through `$requestIds[owner_]` -- the owner's LATEST entry. Earlier entries
    ///      are not reachable and must wait for the queue. Supports partial removal, which shrinks the entry
    ///      in place and leaves it queued.
    function removeShares(uint256 shares_, address owner_) external returns (uint256 sharesReturned) {
        uint128 requestId_ = uint128($requestIds[owner_]);
        if (requestId_ == 0) revert Err("WM:RS:NOT_IN_QUEUE");

        WithdrawalRequest memory request_ = $queue.requests[requestId_];
        if (request_.owner != owner_) revert Err("WM:RS:NOT_OWNER");
        if (shares_ == 0 || shares_ > request_.shares) revert Err("WM:RS:INVALID_SHARES");

        if (shares_ == request_.shares) {
            _removeRequest(owner_, requestId_);
        } else {
            $queue.requests[requestId_].shares = request_.shares - shares_;
        }

        $totalShares -= shares_;
        ERC20($pool).safeTransfer(owner_, shares_);

        return shares_;
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

    /// @dev A queued request. Zeroed once fully processed; `shares` shrinks on a partial fill.
    function requests(uint256 requestId_) external view returns (address owner_, uint256 shares_) {
        // casting to 'uint128' is safe because queue ids are minted as uint128, so any id above that range
        // cannot correspond to an existing request; the widened parameter only matches the real V2 ABI.
        // forge-lint: disable-next-line(unsafe-typecast)
        WithdrawalRequest memory request_ = $queue.requests[uint128(requestId_)];
        return (request_.owner, request_.shares);
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
        $totalShares -= processedShares_;

        IMaplePool($pool).redeem(processedShares_, request_.owner, address(this));
    }

    /// @dev Clears the owner's pointer only when it still points at the request being removed, so an owner with
    ///      several queued requests keeps a non-zero pointer until the last of them is serviced.
    function _removeRequest(address owner_, uint128 requestId_) internal {
        if ($requestIds[owner_] == requestId_) delete $requestIds[owner_];
        delete $queue.requests[requestId_];
    }

    function _calculateRedemption(uint256 sharesToRedeem_)
        internal
        view
        returns (uint256 redeemableShares_, uint256 resultingAssets_)
    {
        // Use the pool's convertToAssets method to ensure consistency with estimation
        uint256 requiredLiquidity_ = IMaplePool($pool).convertToAssets(sharesToRedeem_);
        uint256 availableLiquidity_ = ERC20(IMaplePool($pool).asset()).balanceOf(address($pool));

        bool partialLiquidity_ = availableLiquidity_ < requiredLiquidity_;

        redeemableShares_ =
            partialLiquidity_ ? sharesToRedeem_ * availableLiquidity_ / requiredLiquidity_ : sharesToRedeem_;

        // Use the pool's convertToAssets method for consistency
        resultingAssets_ = IMaplePool($pool).convertToAssets(redeemableShares_);
    }
}
