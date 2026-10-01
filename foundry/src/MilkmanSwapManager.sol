// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal CoW/Milkman surface this manager drives.
/// @dev    `requestSwapExactTokensForTokens` is called on the ROOT Milkman: it deploys a fresh
///         per-order clone via CREATE and escrows `amountIn` into it. `cancelSwap` is called on the
///         CLONE (the per-order contract), which recomputes the swap hash from the same params and
///         refunds `amountIn` to `msg.sender` (the original creator = this manager).
///
///         These signatures match the Milkman **deployed at
///         `0x060373D064d0168931dE2AB8DDA7410923d06E88`** — the 7-parameter variant with a
///         `bytes32 appData` between `to` and `priceChecker` (dispatched selectors `0xda5f2485` /
///         `0x3a25bd98`, present in the deployed bytecode and used by this repo's mainnet-exercised
///         `templates/milkman/milkman.tmpl` and `test/fork/templates/Milkman.t.sol`).
///         NB: the `charlesndalton/milkman` GitHub `main` source is a *different* 6-parameter
///         variant (no `appData`) — do NOT use it as the ABI reference for the deployed target.
interface IMilkman {
    function requestSwapExactTokensForTokens(
        uint256 amountIn,
        IERC20 fromToken,
        IERC20 toToken,
        address to,
        bytes32 appData,
        address priceChecker,
        bytes calldata priceCheckerData
    ) external;

    function cancelSwap(
        uint256 amountIn,
        IERC20 fromToken,
        IERC20 toToken,
        address to,
        bytes32 appData,
        address priceChecker,
        bytes calldata priceCheckerData
    ) external;
}

/// @title  MilkmanSwapManager
/// @notice Wrapper around the deployed Milkman that owns the CoW order lifecycle for a single Safe.
///         `openSwap` / `cancelSwap` are `onlySafe` — invoked through the Safe's Zodiac Roles modifier
///         (a keeper role-member triggers them), so the RAIL-28 Roles policy governs what may be
///         traded. Foundational piece for RAIL-26 (M4). RAIL-27 folds the NavSettler (Lagoon
///         `valuationManager`) logic onto this contract and reuses `isPending()` as the quiescence
///         gate for `pushNav` — NAV is only ever computed at rest.
///
/// @dev    SECURITY INVARIANTS:
///
///         (1) ONE ORDER AT A TIME. At most one live CoW order exists per manager; `_pending` holds
///             its (our-owned) Milkman clone. `openSwap` refuses while an order is live.
///
///         (2) TRUSTLESS CLONE BINDING. Milkman creates the clone via CREATE (address = f(Milkman's
///             account nonce), not derivable on-chain and racing every other caller's request). The
///             keeper supplies `expectedCloneAddress` (computed off-chain from Milkman's nonce);
///             `openSwap` binds it ATOMICALLY: assert no code at the address -> call `requestSwap` ->
///             assert code now present. Within one tx (nonReentrant) the only deployment is Milkman's
///             single clone, so success proves the clone is ours. A stale nonce / race means the
///             predicted address is already occupied -> revert. A wrong or even malicious
///             `expectedCloneAddress` can only cause a revert, never a mis-binding. The prediction is
///             front-runnable (anyone can bump Milkman's nonce with a dust order to occupy the
///             predicted address) — this is bounded griefing (revert, no fund/binding risk); the
///             keeper refreshes the nonce and retries.
///
///         (3) QUIESCENCE GATE, DONATION-SAFE. `isPending()` tests `balanceOf(clone) >= amountIn`,
///             NOT `!= 0`. Milkman orders are fill-or-kill, so a clone legitimately holds exactly
///             `amountIn` (pending) or 0 (filled/cancelled). ERC-20 balances can only be INCREASED by
///             a third party (donation), so the gate can only be pushed further into "pending" — it
///             can never be tricked into "done" while the escrow is still there. A donation therefore
///             cannot corrupt NAV (the gate is a safety condition, not a value); jamming it costs
///             >= a full `amountIn`, stranded in a dead clone, per cycle -> a bounded, uneconomic DoS
///             (and `cancelSwap` sweeps the stranded balance back to the Safe). This assumes a
///             STANDARD ERC-20 `fromToken`: no fee-on-transfer, no rebasing — otherwise a clone could
///             hold `< amountIn` while genuinely pending and the gate would read a live order as done
///             (premature quiescence). Do not add fee-on-transfer / rebasing tokens.
///
///         (4) PROCEEDS TO THE SAFE. Every order's CoW receiver is pinned to `SAFE`, so a fill lands
///             the bought token directly in the Safe (counted by a Safe-balance NAV). `cancelSwap`
///             reclaims the escrowed sold token to this manager and forwards it to `SAFE` in the same
///             tx, so a Safe-balance NAV stays correct.
///
///         (5) NO SETTERS. `MILKMAN` / `SAFE` / `KEEPER` are immutable; to change any, redeploy.
///
///         (6) TRUST BOUNDARY — FUND SAFETY LIVES IN THE SAFE'S ROLES POLICY. `openSwap` / `cancelSwap`
///             are `onlySafe`: they are reachable only by the Safe calling this contract through its
///             Zodiac Roles modifier (a keeper role-member triggers `execTransactionWithRole`). This
///             contract does NOT itself constrain `toToken`, `priceChecker`, `priceCheckerData`,
///             `appData`, or `amountIn` — but because every open/cancel is Safe-routed, the RAIL-28
///             Roles policy CAN and MUST pin `priceChecker` + the feed path inside `priceCheckerData`
///             and cap `amountIn` / the Safe->manager approval. Without that policy a compromised role
///             member could pick a feed reporting ~0 and drain the approved balance within CoW's
///             slippage mechanics, so: do NOT grant the Safe->manager allowance before the policy is
///             in place. The manager's own guarantee is trustlessness of NAV, not of value.
contract MilkmanSwapManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @param clone            Our-owned Milkman order clone (the escrow holder) for the live order.
    /// @param amountIn         Sold amount escrowed in the clone (the fill-or-kill sell amount).
    /// @param fromToken        Sold token — what the clone holds while the order is pending.
    /// @param toToken          Bought token.
    /// @param appData          CoW order metadata; part of the order identity AND folded into
    ///                         Milkman's swap hash, so it must be replayed verbatim on cancel.
    /// @param priceChecker     CoW price checker pinned on the order.
    /// @param priceCheckerData Its encoded config (feeds + slippage); stored to recompute the swap
    ///                         hash when cancelling (Milkman's cancel re-derives it from the params).
    struct PendingOrder {
        address clone;
        uint256 amountIn;
        IERC20 fromToken;
        IERC20 toToken;
        bytes32 appData;
        address priceChecker;
        bytes priceCheckerData;
    }

    error NotSafe();
    error ZeroAddress();
    error ZeroAmount();
    error OrderPending(); // a live order already exists
    error NoPendingOrder(); // nothing live to cancel
    error CloneAlreadyExists(); // code already at expectedCloneAddress before requestSwap (stale nonce / race)
    error CloneNotCreated(); // no code at expectedCloneAddress after requestSwap (wrong prediction)

    event SwapOpened(address indexed clone, address indexed fromToken, address indexed toToken, uint256 amountIn);
    event SwapCanceled(address indexed clone, uint256 reclaimed);

    IMilkman public immutable MILKMAN; // the deployed root Milkman
    address public immutable SAFE; // the Lagoon vault's Safe: funds source, pinned CoW receiver, and the sole authorized caller of openSwap/cancelSwap (via its Roles modifier)

    PendingOrder private _pending;

    modifier onlySafe() {
        if (msg.sender != SAFE) revert NotSafe();
        _;
    }

    constructor(IMilkman milkman, address safe) {
        if (address(milkman) == address(0) || safe == address(0)) revert ZeroAddress();
        MILKMAN = milkman;
        SAFE = safe;
    }

    /// @notice True while a live order's escrow is still in its clone. Donation-safe (invariant 3).
    /// @dev    RAIL-27's `pushNav` MUST gate on this so NAV is only ever taken at rest.
    function isPending() public view returns (bool) {
        address clone = _pending.clone;
        return clone != address(0) && _pending.fromToken.balanceOf(clone) >= _pending.amountIn;
    }

    /// @notice The current pending order (its `clone`/`amountIn` are zero when there is none).
    function pendingOrder() external view returns (PendingOrder memory) {
        return _pending;
    }

    /// @notice Open one CoW/Milkman sell order for the Safe and bind its clone atomically.
    /// @param  amountIn             Amount of `fromToken` to sell (pulled from the Safe).
    /// @param  fromToken            Token to sell.
    /// @param  toToken              Token to buy.
    /// @param  appData              CoW order metadata (see PendingOrder.appData); replayed on cancel.
    /// @param  priceChecker         CoW price checker to pin on the order (e.g. DynamicSlippageChecker).
    /// @param  priceCheckerData     Encoded price-checker config (slippage bps + feed path).
    /// @param  expectedCloneAddress Clone address the keeper computed off-chain from Milkman's nonce.
    function openSwap(
        uint256 amountIn,
        IERC20 fromToken,
        IERC20 toToken,
        bytes32 appData,
        address priceChecker,
        bytes calldata priceCheckerData,
        address expectedCloneAddress
    ) external onlySafe nonReentrant {
        if (isPending()) revert OrderPending();
        if (amountIn == 0) revert ZeroAmount();
        if (_codeSize(expectedCloneAddress) != 0) revert CloneAlreadyExists();

        // Fund from the Safe, then approve the root Milkman for exactly this order.
        fromToken.safeTransferFrom(SAFE, address(this), amountIn);
        fromToken.forceApprove(address(MILKMAN), amountIn);

        // Milkman deploys the clone (CREATE) and pulls `amountIn` into it; receiver pinned to the Safe.
        MILKMAN.requestSwapExactTokensForTokens(
            amountIn, fromToken, toToken, SAFE, appData, priceChecker, priceCheckerData
        );

        // Atomic binding: the clone must now exist exactly at the predicted address (see invariant 2).
        if (_codeSize(expectedCloneAddress) == 0) revert CloneNotCreated();

        _pending = PendingOrder({
            clone: expectedCloneAddress,
            amountIn: amountIn,
            fromToken: fromToken,
            toToken: toToken,
            appData: appData,
            priceChecker: priceChecker,
            priceCheckerData: priceCheckerData
        });

        emit SwapOpened(expectedCloneAddress, address(fromToken), address(toToken), amountIn);
    }

    /// @notice Cancel the live order, reclaim its escrowed sold token, and forward it to the Safe.
    /// @dev    Reverts if there is no live order (nothing to cancel — e.g. already filled), so the
    ///         cancel-vs-fill race resolves to a clean revert. Milkman's clone refunds `amountIn` to
    ///         `msg.sender` (this manager); we sweep the manager's balance to the Safe. All order
    ///         params — including `appData` — are replayed so the clone's creator-proof re-derivation
    ///         matches its stored swap hash.
    function cancelSwap() external onlySafe nonReentrant {
        if (!isPending()) revert NoPendingOrder();

        PendingOrder memory p = _pending;
        delete _pending; // effects before interactions; rolled back if the cancel below reverts

        IMilkman(p.clone)
            .cancelSwap(p.amountIn, p.fromToken, p.toToken, SAFE, p.appData, p.priceChecker, p.priceCheckerData);

        uint256 reclaimed = p.fromToken.balanceOf(address(this));
        if (reclaimed != 0) p.fromToken.safeTransfer(SAFE, reclaimed);

        emit SwapCanceled(p.clone, reclaimed);
    }

    function _codeSize(address a) private view returns (uint256 s) {
        assembly {
            s := extcodesize(a)
        }
    }
}
