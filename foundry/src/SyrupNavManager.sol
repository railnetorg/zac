// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILagoonValuation} from "./interfaces/ILagoonValuation.sol";
import {IMaplePool} from "./interfaces/IMaplePool.sol";
import {IPoolPermissionManager} from "./interfaces/IPoolPermissionManager.sol";
import {IRoleRegistry} from "./interfaces/IRoleRegistry.sol";
import {ISyrupPoolManager} from "./interfaces/ISyrupPoolManager.sol";
import {ISyrupRouter} from "./interfaces/ISyrupRouter.sol";
import {ISyrupWithdrawalManager} from "./interfaces/ISyrupWithdrawalManager.sol";
import {IZodiacRoles} from "./interfaces/IZodiacRoles.sol";

/// @notice Deployment parameters for a SyrupNavManager instance.
/// @dev Passed as a struct because the manager is immutable and takes thirteen arguments; a positional list at
///      that width is a misconfiguration hazard on a fund-critical contract.
/// @param accessControl The external role registry that gates the keeper and guardian roles.
/// @param vault The Lagoon vault this manager is the `valuationManager` of.
/// @param roles The Zodiac Roles v2 modifier the manager executes the Safe's calls through.
/// @param roleKey The manager's role key on that modifier.
/// @param syrupRouter The Syrup router serving the target Maple pool.
/// @param depositData Maple's `bytes32` attribution tag, conventionally `0:<integrator-name>`.
/// @param initialRate The WAD-scaled exit rate expected at deployment, which anchors the band the first push
///        must fall inside. The band is self-referential afterwards, so this is the only externally supplied
///        reference point in the valuation.
/// @param initialRateToleranceBps How far, in basis points, the first accepted rate may sit from `initialRate`.
/// @param maxRateGrowthPerSecond The largest accepted WAD-scaled rate increase per second.
/// @param maxRateDropBps The largest accepted rate decrease, in basis points, regardless of elapsed time.
/// @param pushCooldown The minimum interval between accepted NAV pushes.
/// @param permissionlessPushDelay The staleness after which anyone may push, as a liveness backstop.
/// @param maxOpenRequests The most withdrawal requests that may be outstanding at once, which bounds the gas
///        of every NAV read.
struct DeploymentParams {
    IRoleRegistry accessControl;
    ILagoonValuation vault;
    IZodiacRoles roles;
    bytes32 roleKey;
    ISyrupRouter syrupRouter;
    bytes32 depositData;
    uint256 initialRate;
    uint256 initialRateToleranceBps;
    uint256 maxRateGrowthPerSecond;
    uint256 maxRateDropBps;
    uint256 pushCooldown;
    uint256 permissionlessPushDelay;
    uint256 maxOpenRequests;
}

/// @notice A guardian's one-shot pre-authorisation of an out-of-band exchange rate.
/// @dev Bounded on both sides and time-limited: a guardian acknowledging a credit loss should not also be
///      opening the door to an unbounded upward revaluation.
/// @param minRate The lowest rate the next push may accept, WAD-scaled.
/// @param maxRate The highest rate the next push may accept, WAD-scaled.
/// @param expiresAt The timestamp after which the acknowledgement is void.
struct Acknowledgement {
    uint256 minRate;
    uint256 maxRate;
    uint256 expiresAt;
}

/// @title  SyrupNavManager
/// @notice Valuation and redemption lifecycle for a Lagoon Safe holding syrupUSDC. Values a Lagoon vault's Safe
///         whose single strategy position is a public Maple (Syrup) pool, and owns the Maple deposit and
///         withdrawal lifecycle on that Safe's behalf.
///
///         Two responsibilities, deliberately in one contract:
///
///         1. **Valuation.** `previewNav` computes the Safe's total assets and `pushNav` proposes it to the
///            Lagoon vault as its `valuationManager`. The manager never settles: the Safe confirms the
///            proposal separately, preserving Lagoon's two-step propose/confirm split.
///         2. **Lifecycle.** `deploy`, `requestRedeem`, `cancelRedeem` and `redeemManual` route the Safe's
///            Maple calls through the Zodiac Roles modifier, so withdrawal bookkeeping is a property of the
///            code rather than of keeper discipline.
///
/// @dev    **Why the escrow term is not optional.** `requestRedeem` moves pool shares out of the Safe and into
///         Maple's withdrawal manager. A NAV computed from Safe balances alone would therefore read a crash the
///         instant a redemption is requested and a spike when the assets are pushed back -- and Lagoon's
///         price-per-share guardrails would reject the settle that prices either move, deadlocking the vault
///         exactly when holders are exiting. {navComponents} values escrowed shares as a third term so the NAV
///         stays continuous across request, partial fill and full service.
///
///         **Why there is also a fourth term.** Maple's delegate can flag an owner for *manual* withdrawal, and
///         v2.0.0 of the queue manager dropped the precondition that no request be open when it does. In that
///         state servicing a request deletes its queue entry without moving assets: the pool shares stay on the
///         withdrawal manager, credited to `lockedShares`, until the owner calls `pool.redeem`. Such shares are
///         absent from the Safe's balance, from `requests(id)` and from the idle balance at once, so a
///         three-term NAV would crater by the full escrow -- with the rate still inside its band, so nothing
///         would refuse the push. {manualShares} closes that hole and {redeemManual} drains it.
///
///         **Why concurrent exits are safe here.** The deployed queue manager (v2.0.0) lets one owner hold
///         arbitrarily many requests, each with its own strictly-increasing id, and `requests(id)` reports each
///         one's remaining shares independently. This manager records every id as it creates it and reads
///         status per id, so several exits may be outstanding at once and none serialises behind another. Order
///         carries no meaning: the escrow term is a sum, and partial fills shrink `requests(id).shares` in
///         place, so they are read from the queue rather than cached. Ids are never reused, so a tracked id
///         cannot be reassigned to a different owner.
///
///         **Why cancellation goes to the withdrawal manager, not the pool.** `Pool.removeShares` takes an
///         owner and an amount, and v2.0.0 satisfies it by walking the owner's requests LIFO across as many
///         entries as needed -- it cannot express "cancel this entry". It is also gated on the pool's
///         `P:removeShares` permission, which for syrupUSDC carries the same bitmap as `P:deposit`, so the
///         escape hatch would vanish exactly when Maple had revoked the Safe's deposit rights.
///         `removeSharesById` is unprivileged, owner-authenticated and exact, so {cancelRedeem} uses it.
///
///         **Why a manager rotation fails closed.** The pool delegate can replace the withdrawal manager. Every
///         tracked id would then read as cleared on the new one, so the escrow term would silently collapse to
///         zero while the rate stayed in band. The manager it created requests against is therefore pinned, and
///         a mismatch reverts every valuation read and lifecycle call until
///         {resolveWithdrawalManagerRotation} confirms the previous manager owes the Safe nothing.
///
///         **Why there is no in-flight gate.** Neither leg has an unobservable window: a Maple deposit mints
///         atomically, and a queued redemption remains fully valued on-chain. A pending request is therefore
///         modelled as a *valued position*, not as an in-flight order, so the NAV keeps refreshing during the
///         queue's multi-day tail instead of going stale and forcing the whole stack onto its async paths.
///
///         **Trust boundary.** The manager holds no custody. Value moves only through the Roles modifier, so
///         the zac-generated policy re-checks every target and parameter independently of this contract's
///         logic. The worst outcome of a bug here is a refused or stale valuation, not a transfer.
///
/// @custom:security The exchange rate is read from the Maple pool itself, with no independent price source.
///         {_checkRateBand} bounds it self-referentially; a pool that misreports within the band is not caught.
contract SyrupNavManager is ReentrancyGuard {
    /* ------------------------------------------------------------ CONSTANTS ------------------------------------------------- */

    /// @notice Role allowed to propose a NAV. Not required once the valuation is stale past the backstop.
    bytes32 public constant NAV_PUSH = keccak256("SYRUP_NAV_MANAGER_PUSH");

    /// @notice Role allowed to deploy the Safe's idle assets into the pool.
    bytes32 public constant NAV_DEPLOY = keccak256("SYRUP_NAV_MANAGER_DEPLOY");

    /// @notice Role allowed to open and cancel the Safe's withdrawal requests.
    bytes32 public constant NAV_REDEEM = keccak256("SYRUP_NAV_MANAGER_REDEEM");

    /// @notice Role allowed to pre-authorise an out-of-band valuation move.
    bytes32 public constant NAV_ACKNOWLEDGE = keccak256("SYRUP_NAV_MANAGER_ACKNOWLEDGE");

    /// @notice The hard ceiling on the configurable outstanding-request cap.
    uint256 public constant MAX_OPEN_REQUESTS_LIMIT = 32;

    /// @dev Basis-points denominator: 10,000 BPS == 100%.
    uint256 internal constant BPS_MAX = 10_000;

    /// @dev Fixed-point scale for the exchange rate: 1e18 == one asset per share.
    uint256 internal constant RATE_SCALE = 1e18;

    /// @dev Safe `Enum.Operation.Call`. The manager never delegatecalls from the Safe.
    uint8 internal constant OPERATION_CALL = 0;

    /// @dev Maple's `PoolPermissionManager` function identifier for depositing. Plain right-padded ASCII, as
    ///      Maple's own `canCall` uses it.
    // casting to 'bytes32' is safe because the literal is a 9-byte ASCII string, well inside 32 bytes, and
    // right-padding is exactly the encoding Maple's `canCall` compares against.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 internal constant FUNCTION_ID_DEPOSIT = bytes32("P:deposit");

    /* ------------------------------------------------------------ IMMUTABLES ----------------------------------------------- */

    /// @notice The external role registry consulted for every role check.
    /// @dev The manager is immutable, so this is its only rotation path: operators are added and removed in the
    ///      registry, never by redeploying.
    IRoleRegistry public immutable ACCESS_CONTROL;

    /// @notice The Lagoon vault this manager proposes valuations to.
    ILagoonValuation public immutable VAULT;

    /// @notice The Zodiac Roles v2 modifier every Safe-side call is routed through.
    IZodiacRoles public immutable ROLES;

    /// @notice The manager's role key on the Roles modifier.
    bytes32 public immutable ROLE_KEY;

    /// @notice The Safe holding the strategy's assets -- the modifier's avatar.
    address public immutable SAFE;

    /// @notice The Syrup router used to deposit into the pool. Public Syrup pools are permissioned at
    ///         function level, so deposits must go through the router rather than the pool directly.
    ISyrupRouter public immutable SYRUP_ROUTER;

    /// @notice The Maple pool the Safe's position is held in.
    IMaplePool public immutable SYRUP_POOL;

    /// @notice The pool's underlying asset, and the vault's.
    IERC20 public immutable ASSET;

    /// @notice Maple's attribution tag, forwarded on every deposit.
    bytes32 public immutable DEPOSIT_DATA;

    /// @notice The WAD-scaled exit rate expected at deployment, anchoring the band the first push must satisfy.
    /// @dev The rate band is self-referential once seeded. This is the only reference point in the valuation
    ///      that does not come from the pool itself, and it exists so the seed cannot be set to whatever the
    ///      pool happened to report at an arbitrary instant.
    uint256 public immutable INITIAL_RATE;

    /// @notice How far, in basis points, the first accepted rate may sit from {INITIAL_RATE}.
    uint256 public immutable INITIAL_RATE_TOLERANCE_BPS;

    /// @notice The largest accepted WAD-scaled rate increase per second of elapsed time.
    uint256 public immutable MAX_RATE_GROWTH_PER_SECOND;

    /// @notice The largest accepted rate decrease in basis points, independent of elapsed time. Sized against
    ///         a plausible single-interval Maple credit loss, not against stablecoin drift.
    uint256 public immutable MAX_RATE_DROP_BPS;

    /// @notice The minimum interval between accepted NAV pushes.
    uint256 public immutable PUSH_COOLDOWN;

    /// @notice The staleness after which anyone may push, as a liveness backstop against a dead keeper.
    uint256 public immutable PERMISSIONLESS_PUSH_DELAY;

    /// @notice The most withdrawal requests that may be outstanding at once.
    /// @dev Every NAV read walks the open set, so this is a gas bound on `previewNav` and therefore on
    ///      `pushNav`. Without it a large enough set would make the vault unvaluable.
    uint256 public immutable MAX_OPEN_REQUESTS;

    /// @dev One whole pool share, used as the rate probe.
    uint256 internal immutable SHARE_UNIT;

    /// @dev One whole asset, used to normalise the rate probe to {RATE_SCALE}.
    uint256 internal immutable ASSET_UNIT;

    /* ------------------------------------------------------------ STORAGE -------------------------------------------------- */

    /// @dev The Maple queue entries this manager has open, unordered. Order carries no meaning: the escrow
    ///      term is a sum and each entry's remaining shares are read from the queue.
    uint256[] private _openRequests;

    /// @dev The WAD-scaled exit rate accepted by the last push. 0 until the first push seeds the band.
    uint256 private _lastRate;

    /// @dev The timestamp of the last accepted push, and the reference point for the growth band.
    uint256 private _lastPushAt;

    /// @dev The total assets proposed by the last push, retained for observability.
    uint256 private _lastNav;

    /// @dev The live guardian acknowledgement, consumed by the next out-of-band push.
    Acknowledgement private _acknowledgement;

    /// @dev The withdrawal manager the open requests were created against, address(0) when this manager is
    ///      owed nothing. Pinned so a rotation by Maple's pool delegate fails closed instead of silently
    ///      dropping every tracked id. See {_activeWithdrawalManager}.
    address private _trackedWithdrawalManager;

    /* ------------------------------------------------------------ EVENTS --------------------------------------------------- */

    /// @dev Emitted when a NAV is proposed to the Lagoon vault. Reports the components so an indexer can
    ///      attribute a move without reading storage.
    /// @param nav The proposed total assets.
    /// @param rate The WAD-scaled exit exchange rate the NAV was computed at.
    /// @param idleAssets The Safe's idle asset balance component.
    /// @param heldAssets The exit value of the pool shares the Safe holds.
    /// @param escrowedAssets The exit value of the pool shares queued for withdrawal.
    /// @param manualAssets The exit value of shares awaiting a manual redeem.
    event NavPushed(
        uint256 nav, uint256 rate, uint256 idleAssets, uint256 heldAssets, uint256 escrowedAssets, uint256 manualAssets
    );

    /// @dev Emitted when idle assets are deployed into the Maple pool.
    /// @param assets The assets deposited.
    /// @param sharesReceived The pool shares the Safe received.
    event Deployed(uint256 assets, uint256 sharesReceived);

    /// @dev Emitted when a withdrawal request is queued.
    /// @param requestId The queue entry id.
    /// @param sharesRequested The shares handed to the withdrawal manager.
    /// @param sharesQueued The shares the queue entry reports as awaiting service.
    /// @param openRequestCount The number of requests outstanding after this one.
    event RedeemRequested(
        uint256 indexed requestId, uint256 sharesRequested, uint256 sharesQueued, uint256 openRequestCount
    );

    /// @dev Emitted when a queued request is cancelled and its shares returned to the Safe.
    /// @param requestId The queue entry that was reduced or removed.
    /// @param sharesReturned The shares returned to the Safe.
    event RedeemCancelled(uint256 indexed requestId, uint256 sharesReturned);

    /// @dev Emitted when the manager drops a request id the withdrawal manager no longer reports as
    ///      outstanding, freeing a slot under the cap.
    /// @param requestId The cleared queue entry id.
    event RequestCleared(uint256 indexed requestId);

    /// @dev Emitted when a guardian pre-authorises an out-of-band exchange rate, typically after a Maple
    ///      credit event whose loss is larger than the automatic drop tolerance.
    /// @param minRate The lowest rate the next push may accept.
    /// @param maxRate The highest rate the next push may accept.
    /// @param expiresAt The timestamp after which the acknowledgement is void.
    event RateAcknowledged(uint256 minRate, uint256 maxRate, uint256 expiresAt);

    /// @dev Emitted when a push consumes a guardian acknowledgement, so the one-shot nature is auditable.
    /// @param rate The rate that was accepted.
    event AcknowledgementConsumed(uint256 rate);

    /// @dev Emitted when a guardian revokes an unused acknowledgement.
    event AcknowledgementRevoked();

    /// @dev Emitted when shares sitting in the Safe's manual withdrawal bucket are redeemed into assets.
    /// @param shares The shares redeemed.
    /// @param assetsReceived The assets the Safe received.
    event ManualRedeemed(uint256 shares, uint256 assetsReceived);

    /// @dev Emitted when a guardian clears tracked requests after the pool's withdrawal manager rotated.
    /// @param previousManager The manager the cleared requests belonged to.
    /// @param currentManager The pool's current manager.
    event WithdrawalManagerRotationResolved(address previousManager, address currentManager);

    /* ------------------------------------------------------------ ERRORS --------------------------------------------------- */

    /// @dev Raised when a constructor argument is not a valid smart contract address.
    /// @param contractAddress The invalid contract address.
    error InvalidContract(address contractAddress);

    /// @dev Raised when the caller does not hold the required role for this contract.
    /// @param role The role required.
    /// @param scope The contract the role is scoped to.
    /// @param account The caller.
    error MissingRole(bytes32 role, address scope, address account);

    /// @dev Raised when an amount that must be non-zero is zero.
    error ZeroAmount();

    /// @dev Raised when the Roles modifier's avatar is not the vault's Safe. Wiring a manager to a modifier
    ///      that drives a different Safe would let it value one book while trading out of another, and the
    ///      vault would have no way to notice.
    /// @param vaultSafe The Safe the Lagoon vault settles through.
    /// @param avatar The modifier's avatar.
    error SafeMismatch(address vaultSafe, address avatar);

    /// @dev Raised when the Lagoon vault's asset is not the Maple pool's asset, which would make the pushed
    ///      NAV denominated in the wrong unit.
    /// @param vaultAsset The vault's asset.
    /// @param poolAsset The pool's asset.
    error AssetMismatch(address vaultAsset, address poolAsset);

    /// @dev Raised when the configured router does not serve the pool derived from it.
    /// @param router The Syrup router.
    /// @param pool The pool the router reported.
    error RouterPoolMismatch(address router, address pool);

    /// @dev Raised when a basis-points bound exceeds 100%.
    /// @param bps The offending value.
    error InvalidBps(uint256 bps);

    /// @dev Raised when a required duration parameter is zero, or the permissionless backstop would open
    ///      before the push cooldown expires.
    error InvalidDuration();

    /// @dev Raised when the growth bound is zero or so large that computing the band would overflow, which
    ///      would brick every push.
    /// @param value The offending value.
    error InvalidRateBound(uint256 value);

    /// @dev Raised when the outstanding-request cap is zero or above {MAX_OPEN_REQUESTS_LIMIT}. The cap is
    ///      what keeps every NAV read's gas bounded.
    /// @param value The offending value.
    error InvalidRequestCap(uint256 value);

    /// @dev Raised when the measured exchange rate leaves the accepted band and no guardian acknowledgement
    ///      covers it. Fail-closed: the NAV is not pushed, so nothing settles on a rate we do not trust.
    /// @param rate The measured rate, WAD-scaled.
    /// @param minRate The lowest accepted rate.
    /// @param maxRate The highest accepted rate.
    error RateOutOfBand(uint256 rate, uint256 minRate, uint256 maxRate);

    /// @dev Raised when `pushNav` is called again before the cooldown elapses. The cooldown exists because
    ///      overwriting a live proposal would make the Safe's value-matching `settle` revert.
    /// @param nextPushAt The earliest timestamp at which a push is accepted.
    error PushCooldown(uint256 nextPushAt);

    /// @dev Raised when a caller without the push role pushes before the permissionless backstop opens.
    /// @param permissionlessAt The timestamp from which anyone may push.
    error PushNotPermissionless(uint256 permissionlessAt);

    /// @dev Raised when opening another request would exceed the outstanding-request cap.
    /// @param cap The configured cap.
    error TooManyOpenRequests(uint256 cap);

    /// @dev Raised when the request id supplied is not one this manager is tracking, or is no longer live.
    /// @param requestId The unknown request id.
    error UnknownRequest(uint256 requestId);

    /// @dev Raised when the id the queue manager reports after a request is zero or one already tracked. The
    ///      deployed queue manager always appends a fresh, strictly-larger id, so this means Maple's behaviour
    ///      has diverged from what this integration models -- fail closed rather than lose the shares from the
    ///      NAV.
    error RequestNotRegistered();

    /// @dev Raised when a manual-bucket redeem returns no assets to the Safe.
    error NoAssetsReceived();

    /// @dev Raised when the queue entry the manager just opened is not owned by the Safe.
    /// @param owner The owner the withdrawal manager reported.
    error RequestOwnerMismatch(address owner);

    /// @dev Raised when the Safe holds fewer pool shares than the operation requires.
    /// @param requested The shares requested.
    /// @param available The shares the Safe holds.
    error InsufficientPoolShares(uint256 requested, uint256 available);

    /// @dev Raised when the Safe holds fewer assets than the deployment requires.
    /// @param requested The assets requested.
    /// @param available The assets the Safe holds.
    error InsufficientAssets(uint256 requested, uint256 available);

    /// @dev Raised when a deployment exceeds the pool's remaining capacity for the Safe. Distinguishes a
    ///      capped pool from a permissioning gap, both of which the router reports as `SR:D:NOT_AUTHORIZED`.
    /// @param requested The assets requested.
    /// @param limit The pool's reported `maxDeposit` for the Safe.
    error DepositExceedsPoolLimit(uint256 requested, uint256 limit);

    /// @dev Raised when a deployment mints fewer pool shares than the caller's floor.
    /// @param received The shares received.
    /// @param minimum The caller's minimum.
    error InsufficientSharesReceived(uint256 received, uint256 minimum);

    /// @dev Raised when cancelling a request returns no shares to the Safe.
    error NoSharesReturned();

    /// @dev Raised when a call routed through the Roles modifier reports failure.
    /// @param target The call target.
    error SafeExecutionFailed(address target);

    /// @dev Raised when a guardian acknowledgement is malformed (inverted or already expired).
    error InvalidAcknowledgement();

    /// @dev Raised when the pool's withdrawal manager is no longer the one the tracked requests were created
    ///      against. Fail-closed: the tracked ids read as cleared on the new manager, so continuing would
    ///      silently drop the whole escrow term from the NAV while the rate stayed inside its band.
    /// @param trackedManager The manager the open requests belong to.
    /// @param currentManager The manager the pool now points at.
    error WithdrawalManagerRotated(address trackedManager, address currentManager);

    /// @dev Raised when {resolveWithdrawalManagerRotation} is called with no rotation pending.
    error NoRotationToResolve();

    /// @dev Raised when a rotation cannot be resolved because the previous manager still owes the Safe. The
    ///      old manager has to service or return those shares first; dropping them would understate the NAV.
    /// @param requestId A request the previous manager still reports as live.
    /// @param queuedShares Its outstanding shares.
    error RotationHasLiveRequests(uint256 requestId, uint256 queuedShares);

    /// @dev Raised when the Safe is not allowlisted for `P:deposit` on Maple's permission manager. Split out
    ///      from {DepositExceedsPoolLimit} because `maxDeposit` returns 0 for this and for a full pool alike,
    ///      and the remedies differ completely: onboarding with Maple versus waiting for capacity.
    /// @param safe The address Maple has not allowlisted.
    error NotAllowlisted(address safe);

    /// @dev Raised when the deployment-time rate anchor is zero, which would make the first-push band
    ///      degenerate and accept any rate at all.
    error InvalidInitialRate();

    /* ------------------------------------------------------------ MODIFIERS ------------------------------------------------ */

    /// @dev Requires the caller to hold `role` in the external registry, globally or scoped to this contract.
    /// @param role The role identifier.
    modifier onlyRole(bytes32 role) {
        _onlyRole(role);
        _;
    }

    /* ------------------------------------------------------------ CONSTRUCTOR ---------------------------------------------- */

    /// @notice Deploys an immutable manager for one Lagoon vault and one Maple pool.
    /// @dev The wiring checks are the point of this constructor. A manager pointed at a modifier whose avatar
    ///      is a different Safe, or at a pool whose asset differs from the vault's, would value one book while
    ///      trading another; both are unrecoverable once the vault trusts it as `valuationManager`.
    /// @param params The deployment parameters.
    constructor(DeploymentParams memory params) {
        _requireContract(address(params.accessControl));
        _requireContract(address(params.vault));
        _requireContract(address(params.roles));
        _requireContract(address(params.syrupRouter));

        if (params.maxRateDropBps > BPS_MAX) {
            revert InvalidBps(params.maxRateDropBps);
        }
        // Bounded above as well as below: an unbounded growth rate makes {rateBand} overflow on a long
        // elapsed interval, which would brick every push rather than merely widening the band.
        if (params.maxRateGrowthPerSecond == 0 || params.maxRateGrowthPerSecond > RATE_SCALE) {
            revert InvalidRateBound(params.maxRateGrowthPerSecond);
        }
        if (params.pushCooldown == 0 || params.permissionlessPushDelay < params.pushCooldown) {
            revert InvalidDuration();
        }
        if (params.maxOpenRequests == 0 || params.maxOpenRequests > MAX_OPEN_REQUESTS_LIMIT) {
            revert InvalidRequestCap(params.maxOpenRequests);
        }
        if (params.initialRate == 0) {
            revert InvalidInitialRate();
        }
        if (params.initialRateToleranceBps > BPS_MAX) {
            revert InvalidBps(params.initialRateToleranceBps);
        }

        // The avatar is the authority on which Safe this modifier drives; trusting a constructor argument
        // instead would let a misconfigured deployment value the wrong book. Cross-checked against the
        // vault's own Safe so the manager cannot value one Safe while the vault settles through another.
        address safe_ = params.roles.avatar();
        if (safe_ == address(0)) {
            revert InvalidContract(safe_);
        }
        address vaultSafe_ = params.vault.safe();
        if (vaultSafe_ != safe_) {
            revert SafeMismatch(vaultSafe_, safe_);
        }

        IMaplePool pool_ = IMaplePool(params.syrupRouter.pool());
        _requireContract(address(pool_));
        address poolAsset_ = pool_.asset();
        address vaultAsset_ = params.vault.asset();
        if (vaultAsset_ != poolAsset_) {
            revert AssetMismatch(vaultAsset_, poolAsset_);
        }
        if (params.syrupRouter.asset() != poolAsset_) {
            revert RouterPoolMismatch(address(params.syrupRouter), address(pool_));
        }

        ACCESS_CONTROL = params.accessControl;
        VAULT = params.vault;
        ROLES = params.roles;
        ROLE_KEY = params.roleKey;
        SAFE = safe_;
        SYRUP_ROUTER = params.syrupRouter;
        SYRUP_POOL = pool_;
        ASSET = IERC20(poolAsset_);
        DEPOSIT_DATA = params.depositData;
        INITIAL_RATE = params.initialRate;
        INITIAL_RATE_TOLERANCE_BPS = params.initialRateToleranceBps;
        MAX_RATE_GROWTH_PER_SECOND = params.maxRateGrowthPerSecond;
        MAX_RATE_DROP_BPS = params.maxRateDropBps;
        PUSH_COOLDOWN = params.pushCooldown;
        PERMISSIONLESS_PUSH_DELAY = params.permissionlessPushDelay;
        MAX_OPEN_REQUESTS = params.maxOpenRequests;
        SHARE_UNIT = 10 ** IERC20Metadata(address(pool_)).decimals();
        ASSET_UNIT = 10 ** IERC20Metadata(poolAsset_).decimals();
    }

    /* ------------------------------------------------------------ VALUATION ------------------------------------------------ */

    /// @notice Proposes the Safe's current total assets to the Lagoon vault.
    /// @dev Role-gated to the keeper under normal operation, and permissionless once the valuation has been
    ///      stale for {PERMISSIONLESS_PUSH_DELAY} so a dead keeper cannot freeze the vault. It is not
    ///      permissionless outright: Lagoon's `settle` must be handed a value matching the live proposal, so
    ///      an unrestricted push would let anyone grief settlement by overwriting it mid-flight. The cooldown
    ///      bounds that window even for the keeper.
    /// @return nav The proposed total assets.
    function pushNav() external nonReentrant returns (uint256 nav) {
        _prune();
        _checkPushAllowed();

        uint256 rate_ = exchangeRate();
        _checkRateBand(rate_);

        (uint256 idle_, uint256 held_, uint256 escrowed_, uint256 manual_) = navComponents();
        nav = idle_ + held_ + escrowed_ + manual_;

        _lastRate = rate_;
        _lastPushAt = block.timestamp;
        _lastNav = nav;

        emit NavPushed(nav, rate_, idle_, held_, escrowed_, manual_);

        // External call last: nothing below depends on the vault's response.
        VAULT.updateNewTotalAssets(nav);
    }

    /* ------------------------------------------------------------ LIFECYCLE ------------------------------------------------ */

    /// @notice Deploys idle assets from the Safe into the Maple pool.
    /// @dev Minting is slippage-free at the pool's exchange rate, so `minSharesOut` is not a price guard but a
    ///      liveness assertion: it fails the call if the router credited the Safe with less than expected,
    ///      rather than silently leaving assets converted at a rate nobody checked. The allowance is granted
    ///      exactly and zeroed afterwards, so no standing approval to the router survives the call.
    /// @param assets The assets to deposit.
    /// @param minSharesOut The minimum pool shares the Safe must receive.
    /// @return sharesReceived The pool shares the Safe received.
    function deploy(uint256 assets, uint256 minSharesOut)
        external
        onlyRole(NAV_DEPLOY)
        nonReentrant
        returns (uint256 sharesReceived)
    {
        if (assets == 0) {
            revert ZeroAmount();
        }

        uint256 available_ = ASSET.balanceOf(SAFE);
        if (assets > available_) {
            revert InsufficientAssets(assets, available_);
        }
        // `maxDeposit` returns 0 both for an un-allowlisted receiver and for a pool at its liquidity cap, and
        // never reverts. Splitting the two matters: one is resolved by Maple's onboarding desk, the other by
        // waiting for capacity. The permission read only happens on the failing path.
        uint256 limit_ = SYRUP_POOL.maxDeposit(SAFE);
        if (assets > limit_) {
            if (limit_ == 0 && !isDepositAllowlisted()) {
                revert NotAllowlisted(SAFE);
            }
            revert DepositExceedsPoolLimit(assets, limit_);
        }

        uint256 sharesBefore_ = SYRUP_POOL.balanceOf(SAFE);

        _exec(address(ASSET), abi.encodeCall(IERC20.approve, (address(SYRUP_ROUTER), assets)));
        _exec(address(SYRUP_ROUTER), abi.encodeCall(ISyrupRouter.deposit, (assets, DEPOSIT_DATA)));
        _exec(address(ASSET), abi.encodeCall(IERC20.approve, (address(SYRUP_ROUTER), 0)));

        sharesReceived = SYRUP_POOL.balanceOf(SAFE) - sharesBefore_;
        if (sharesReceived < minSharesOut) {
            revert InsufficientSharesReceived(sharesReceived, minSharesOut);
        }

        emit Deployed(assets, sharesReceived);
    }

    /// @notice Queues a withdrawal of the Safe's pool shares. Several may be outstanding at once, up to
    ///         {MAX_OPEN_REQUESTS}.
    /// @dev The new id is captured from `requestIds(SAFE)` immediately after the call. That read is
    ///      unambiguous: the queue manager appends every request as `++queue.lastRequestId`, strictly greater
    ///      than any id it has ever issued, and it has no path that services a request inside the transaction
    ///      that creates it. From then on the entry is tracked by id and read via `requests(id)`, so the
    ///      manager never depends on `requestIds` again and concurrent requests stay distinguishable.
    ///
    ///      A zero or already-tracked id therefore means the queue did not behave the way this integration
    ///      models it. That fails closed rather than being interpreted, because the shares have already left
    ///      the Safe and an untracked request is one the NAV cannot see.
    /// @param shares The pool shares to queue.
    /// @return requestId The queue entry id.
    function requestRedeem(uint256 shares) external onlyRole(NAV_REDEEM) nonReentrant returns (uint256 requestId) {
        _prune();

        if (_openRequests.length >= MAX_OPEN_REQUESTS) {
            revert TooManyOpenRequests(MAX_OPEN_REQUESTS);
        }

        if (shares == 0) {
            revert ZeroAmount();
        }
        uint256 available_ = SYRUP_POOL.balanceOf(SAFE);
        if (shares > available_) {
            revert InsufficientPoolShares(shares, available_);
        }

        ISyrupWithdrawalManager withdrawalManager_ = _activeWithdrawalManager();

        _exec(address(SYRUP_POOL), abi.encodeCall(IMaplePool.requestRedeem, (shares, SAFE)));

        requestId = withdrawalManager_.requestIds(SAFE);
        if (requestId == 0 || _isTracked(requestId)) {
            revert RequestNotRegistered();
        }

        (address owner_, uint256 queued_) = withdrawalManager_.requests(requestId);
        if (owner_ != SAFE) {
            revert RequestOwnerMismatch(owner_);
        }

        _openRequests.push(requestId);
        // Pin the manager these ids belong to, so a later rotation fails closed instead of dropping them.
        _trackedWithdrawalManager = address(withdrawalManager_);

        emit RedeemRequested(requestId, shares, queued_, _openRequests.length);
    }

    /// @notice Cancels one outstanding withdrawal request, returning its shares to the Safe.
    /// @dev The escape hatch for a request stuck behind Maple's FIFO queue.
    ///
    ///      Cancels through the withdrawal manager's `removeSharesById` rather than `Pool.removeShares`, for
    ///      two reasons. First, precision: the pool's variant takes an owner and an amount, and the deployed
    ///      queue manager satisfies it by walking the owner's requests LIFO across as many entries as needed,
    ///      so it cannot express "this entry". Second, and more important, `Pool.removeShares` runs
    ///      `checkCall("P:removeShares")`, whose bitmap on syrupUSDC is the same one as `P:deposit` -- so the
    ///      escape hatch would die the moment Maple revoked the Safe's deposit rights, which is precisely when
    ///      a stuck exit needs unwinding. `removeSharesById` is unprivileged and owner-authenticated, and the
    ///      Safe is the owner, so it stays available.
    /// @param requestId The queue entry to cancel.
    /// @return sharesReturned The pool shares returned to the Safe.
    function cancelRedeem(uint256 requestId)
        external
        onlyRole(NAV_REDEEM)
        nonReentrant
        returns (uint256 sharesReturned)
    {
        if (!_isTracked(requestId)) {
            revert UnknownRequest(requestId);
        }

        ISyrupWithdrawalManager withdrawalManager_ = _activeWithdrawalManager();

        (address owner_, uint256 queued_) = withdrawalManager_.requests(requestId);
        if (owner_ != SAFE || queued_ == 0) {
            // Already serviced or removed out of band: drop it from the open set rather than calling Maple.
            _prune();
            revert UnknownRequest(requestId);
        }

        uint256 sharesBefore_ = SYRUP_POOL.balanceOf(SAFE);

        _exec(
            address(withdrawalManager_), abi.encodeCall(ISyrupWithdrawalManager.removeSharesById, (requestId, queued_))
        );

        sharesReturned = SYRUP_POOL.balanceOf(SAFE) - sharesBefore_;
        if (sharesReturned == 0) {
            revert NoSharesReturned();
        }

        // Re-derive rather than delete: the entry is gone only if the whole remainder was removed.
        _prune();

        emit RedeemCancelled(requestId, sharesReturned);
    }

    /// @notice Drops request ids the withdrawal manager no longer reports as outstanding.
    /// @dev Permissionless, and the reason serviced requests cannot hold slots under {MAX_OPEN_REQUESTS}
    ///      while the keeper is down.
    function pruneRequests() external {
        _prune();
    }

    /// @notice Redeems shares the withdrawal manager has serviced into the Safe's manual bucket.
    /// @dev The recovery path for the manual-withdrawal state. When Maple's delegate has flagged the Safe,
    ///      `processRedemptions` deletes the queue entry and credits `lockedShares` instead of paying out, so
    ///      the assets only move when the owner asks. {navComponents} values those shares in the meantime, so
    ///      this call is about liquidity, not about correcting a valuation.
    /// @param shares The shares to redeem out of the manual bucket.
    /// @return assetsReceived The assets the Safe received.
    function redeemManual(uint256 shares) external onlyRole(NAV_REDEEM) nonReentrant returns (uint256 assetsReceived) {
        if (shares == 0) {
            revert ZeroAmount();
        }

        ISyrupWithdrawalManager withdrawalManager_ = _activeWithdrawalManager();
        uint256 available_ = withdrawalManager_.lockedShares(SAFE);
        if (shares > available_) {
            revert InsufficientPoolShares(shares, available_);
        }

        uint256 assetsBefore_ = ASSET.balanceOf(SAFE);

        _exec(address(SYRUP_POOL), abi.encodeCall(IMaplePool.redeem, (shares, SAFE, SAFE)));

        assetsReceived = ASSET.balanceOf(SAFE) - assetsBefore_;
        if (assetsReceived == 0) {
            revert NoAssetsReceived();
        }

        // May release the manager pin, if this drained the last thing it owed the Safe.
        _prune();

        emit ManualRedeemed(shares, assetsReceived);
    }

    /// @notice Clears tracked requests after Maple rotated the pool's withdrawal manager.
    /// @dev While a rotation is pending every valuation read and lifecycle call reverts
    ///      {WithdrawalManagerRotated}, because the tracked ids read as cleared on the new manager and the
    ///      escrow term would silently collapse. This is the way out, and it is not an override: it refuses
    ///      unless the *previous* manager reports every tracked request settled and no shares left in the
    ///      manual bucket -- which is exactly the condition under which those assets have already landed in
    ///      the Safe and are counted as idle. Guardian-gated because it is a valuation-affecting action.
    function resolveWithdrawalManagerRotation() external onlyRole(NAV_ACKNOWLEDGE) {
        address tracked_ = _trackedWithdrawalManager;
        address current_ = ISyrupPoolManager(SYRUP_POOL.manager()).withdrawalManager();
        if (tracked_ == address(0) || tracked_ == current_) {
            revert NoRotationToResolve();
        }

        ISyrupWithdrawalManager previous_ = ISyrupWithdrawalManager(tracked_);
        uint256[] memory ids_ = _openRequests;
        uint256 length_ = ids_.length;
        for (uint256 idx_ = 0; idx_ < length_; ++idx_) {
            (address owner_, uint256 queued_) = previous_.requests(ids_[idx_]);
            if (owner_ == SAFE && queued_ != 0) {
                revert RotationHasLiveRequests(ids_[idx_], queued_);
            }
        }
        uint256 locked_ = previous_.lockedShares(SAFE);
        if (locked_ != 0) {
            revert RotationHasLiveRequests(0, locked_);
        }

        delete _openRequests;
        _trackedWithdrawalManager = address(0);

        emit WithdrawalManagerRotationResolved(tracked_, current_);
    }

    /* ------------------------------------------------------------ GUARDIAN ------------------------------------------------- */

    /// @notice Pre-authorises an out-of-band exchange rate for the next push.
    /// @dev The human-in-the-loop moment for a Maple credit event. An automatic push of a loss larger than
    ///      {MAX_RATE_DROP_BPS} is refused by design; a guardian states the band it accepts and the next push
    ///      consumes it. Bounded on both sides and time-limited, so acknowledging a loss does not also
    ///      authorise an unbounded upward revaluation.
    /// @param minRate The lowest rate the next push may accept, WAD-scaled.
    /// @param maxRate The highest rate the next push may accept, WAD-scaled.
    /// @param expiresAt The timestamp after which the acknowledgement is void.
    function acknowledgeRate(uint256 minRate, uint256 maxRate, uint256 expiresAt) external onlyRole(NAV_ACKNOWLEDGE) {
        if (minRate == 0 || minRate > maxRate || expiresAt <= block.timestamp) {
            revert InvalidAcknowledgement();
        }
        _acknowledgement = Acknowledgement({minRate: minRate, maxRate: maxRate, expiresAt: expiresAt});
        emit RateAcknowledged(minRate, maxRate, expiresAt);
    }

    /// @notice Revokes an unused acknowledgement.
    function revokeAcknowledgement() external onlyRole(NAV_ACKNOWLEDGE) {
        delete _acknowledgement;
        emit AcknowledgementRevoked();
    }

    /* ------------------------------------------------------------ EXTERNAL VIEWS ------------------------------------------- */

    /// @notice The Maple queue entries this manager currently has open.
    /// @return requestIds The open request ids, unordered.
    function openRequests() external view returns (uint256[] memory requestIds) {
        return _openRequests;
    }

    /// @notice The state left by the last accepted push.
    /// @return nav The proposed total assets.
    /// @return rate The WAD-scaled rate it was computed at.
    /// @return pushedAt The timestamp of the push, 0 if none has happened.
    function lastPush() external view returns (uint256 nav, uint256 rate, uint256 pushedAt) {
        return (_lastNav, _lastRate, _lastPushAt);
    }

    /// @notice The live guardian acknowledgement.
    /// @return liveAcknowledgement The acknowledgement; a zero `expiresAt` means none is set.
    function acknowledgement() external view returns (Acknowledgement memory liveAcknowledgement) {
        return _acknowledgement;
    }

    /* ------------------------------------------------------------ PUBLIC VIEWS --------------------------------------------- */

    /// @notice The Safe's total assets, as this manager would propose them.
    /// @return nav The total assets, denominated in the vault's asset.
    function previewNav() public view returns (uint256 nav) {
        (uint256 idle_, uint256 held_, uint256 escrowed_, uint256 manual_) = navComponents();
        return idle_ + held_ + escrowed_ + manual_;
    }

    /// @notice The four components of the NAV, broken out so a keeper or indexer can attribute a move.
    /// @dev All pool-share valuation goes through `convertToExitAssets`, never `convertToAssets`: the exit
    ///      variant applies the pool's unrealized-loss haircut, so the figure is what a redeemer would
    ///      actually receive rather than an optimistic mark. Shares are summed per term and converted once, so
    ///      splitting one exit across several requests cannot change the valuation.
    ///
    ///      **Why there is a fourth term.** If Maple's delegate flags the Safe for manual withdrawal, servicing
    ///      a request deletes its queue entry *without moving assets*: the pool shares stay on the withdrawal
    ///      manager and the Safe must call `pool.redeem` to collect. Those shares are then absent from the
    ///      Safe's balance, absent from `requests(id)`, and absent from the idle balance -- so a three-term NAV
    ///      would crater by the full escrow with the rate still inside its band, and Lagoon's price-per-share
    ///      guardrail would reject the settle. That is the deadlock this contract exists to prevent, so the
    ///      manual bucket is valued unconditionally rather than behind a flag read.
    /// @return idleAssets The Safe's undeployed asset balance.
    /// @return heldAssets The exit value of the pool shares the Safe holds.
    /// @return escrowedAssets The exit value of the pool shares queued for withdrawal.
    /// @return manualAssets The exit value of shares serviced into the Safe's manual bucket, awaiting redeem.
    function navComponents()
        public
        view
        returns (uint256 idleAssets, uint256 heldAssets, uint256 escrowedAssets, uint256 manualAssets)
    {
        ISyrupWithdrawalManager withdrawalManager_ = _activeWithdrawalManager();
        idleAssets = ASSET.balanceOf(SAFE);
        heldAssets = SYRUP_POOL.convertToExitAssets(SYRUP_POOL.balanceOf(SAFE));
        escrowedAssets = SYRUP_POOL.convertToExitAssets(_escrowedShares(withdrawalManager_));
        manualAssets = SYRUP_POOL.convertToExitAssets(withdrawalManager_.lockedShares(SAFE));
    }

    /// @notice The pool shares still awaiting service across every open request.
    /// @dev Reads each entry from the queue rather than trusting stored share counts, because the pool
    ///      delegate shrinks `requests(id).shares` in place on a partial fill. The `owner == SAFE` check means
    ///      a cleared, reassigned or foreign entry contributes nothing instead of inflating the NAV. Bounded
    ///      by {MAX_OPEN_REQUESTS}.
    ///
    ///      Does not cover shares the delegate has moved into the manual bucket -- those leave the queue
    ///      entirely. See {manualShares}.
    /// @return shares The shares still queued, 0 when nothing is outstanding.
    function escrowedShares() public view returns (uint256 shares) {
        if (_openRequests.length == 0) {
            return 0;
        }
        return _escrowedShares(_activeWithdrawalManager());
    }

    /// @notice The pool's current WAD-scaled exit exchange rate: assets per whole share.
    /// @return rate The exit rate, where {RATE_SCALE} means one asset per share.
    function exchangeRate() public view returns (uint256 rate) {
        return Math.mulDiv(SYRUP_POOL.convertToExitAssets(SHARE_UNIT), RATE_SCALE, ASSET_UNIT);
    }

    /// @notice The pool's withdrawal manager.
    /// @dev Resolved on every read rather than stored: Maple's pool delegate can rotate the withdrawal
    ///      manager, and a cached address would silently value the wrong queue afterwards.
    /// @return manager The withdrawal manager.
    function withdrawalManager() public view returns (ISyrupWithdrawalManager manager) {
        return ISyrupWithdrawalManager(ISyrupPoolManager(SYRUP_POOL.manager()).withdrawalManager());
    }

    /// @notice The shares the withdrawal manager has serviced into the Safe's manual bucket but not yet paid.
    /// @dev Non-zero only while Maple's delegate has flagged the Safe for manual withdrawal. {redeemManual}
    ///      converts them back into assets.
    /// @return shares The shares awaiting a manual redeem.
    function manualShares() public view returns (uint256 shares) {
        return _activeWithdrawalManager().lockedShares(SAFE);
    }

    /// @notice Whether the pool's withdrawal manager has rotated away from the one tracked requests belong to.
    /// @dev A keeper should treat this as page-a-human, not retry: while it is true, every valuation read and
    ///      every lifecycle call reverts {WithdrawalManagerRotated} by design.
    /// @return rotated True when a rotation is pending resolution.
    /// @return tracked The manager the open requests were created against, address(0) when nothing is pinned.
    /// @return current The pool's current manager.
    function withdrawalManagerRotated() public view returns (bool rotated, address tracked, address current) {
        tracked = _trackedWithdrawalManager;
        current = ISyrupPoolManager(SYRUP_POOL.manager()).withdrawalManager();
        rotated = tracked != address(0) && tracked != current;
    }

    /// @notice The three facts a keeper needs to decide whether to push, in one call.
    /// @dev Deliberately reports facts rather than a verdict: the vault's valuation lifespan is Lagoon's
    ///      parameter, not this contract's, so only the keeper knows how far ahead of expiry it wants to push.
    /// @return cooldownElapsed Whether {PUSH_COOLDOWN} has passed since the last accepted push.
    /// @return permissionless Whether the staleness backstop has opened, making the push callable by anyone.
    /// @return valuationValid Whether the vault's cached `totalAssets` is still inside its lifespan.
    function pushStatus() public view returns (bool cooldownElapsed, bool permissionless, bool valuationValid) {
        uint256 lastPushAt_ = _lastPushAt;
        valuationValid = VAULT.isTotalAssetsValid();
        if (lastPushAt_ == 0) {
            return (true, false, valuationValid);
        }
        cooldownElapsed = block.timestamp >= lastPushAt_ + PUSH_COOLDOWN;
        permissionless = block.timestamp >= lastPushAt_ + PERMISSIONLESS_PUSH_DELAY;
    }

    /// @notice Whether Maple currently permits the Safe to deposit.
    /// @dev The deployment preflight, and what {deploy} consults to tell a permissioning gap apart from a full
    ///      pool -- `maxDeposit` returns 0 for both and never reverts.
    /// @return allowed True when the Safe holds `P:deposit` permission.
    function isDepositAllowlisted() public view returns (bool allowed) {
        return IPoolPermissionManager(SYRUP_ROUTER.poolPermissionManager())
            .hasPermission(SYRUP_ROUTER.poolManager(), SAFE, FUNCTION_ID_DEPOSIT);
    }

    /// @notice The exchange-rate band the next push would accept.
    /// @dev Exposed so a keeper can tell a refused push apart from a rate that has genuinely left the band,
    ///      and page a guardian instead of retrying.
    ///
    ///      The band is self-referential once seeded, so the seed itself has to come from somewhere. Anchoring
    ///      the unseeded band on {INITIAL_RATE} keeps the first push -- the moment the vault starts trusting
    ///      this manager as its `valuationManager` -- from setting the anchor for every later band to whatever
    ///      the pool happened to report at an arbitrary instant.
    /// @return minRate The lowest accepted rate, WAD-scaled.
    /// @return maxRate The highest accepted rate, WAD-scaled.
    function rateBand() public view returns (uint256 minRate, uint256 maxRate) {
        uint256 lastRate_ = _lastRate;
        if (lastRate_ == 0) {
            uint256 tolerance_ = Math.mulDiv(INITIAL_RATE, INITIAL_RATE_TOLERANCE_BPS, BPS_MAX);
            return (INITIAL_RATE - tolerance_, INITIAL_RATE + tolerance_);
        }
        uint256 elapsed_ = block.timestamp - _lastPushAt;
        minRate = lastRate_ - Math.mulDiv(lastRate_, MAX_RATE_DROP_BPS, BPS_MAX);
        maxRate = lastRate_ + Math.mulDiv(lastRate_, MAX_RATE_GROWTH_PER_SECOND * elapsed_, RATE_SCALE);
    }

    /* ------------------------------------------------------------ INTERNALS ------------------------------------------------ */

    /// @dev Drops every open request the withdrawal manager no longer reports as outstanding. Iterates
    ///      downward with swap-and-pop, which is safe because the element swapped in has already been
    ///      examined and kept. Called before every state transition that reads or takes a slot.
    function _prune() internal {
        uint256 length_ = _openRequests.length;
        if (length_ == 0) {
            return;
        }
        ISyrupWithdrawalManager withdrawalManager_ = _activeWithdrawalManager();
        for (uint256 cursor_ = length_; cursor_ > 0; --cursor_) {
            uint256 idx_ = cursor_ - 1;
            uint256 requestId_ = _openRequests[idx_];
            (address owner_, uint256 queued_) = withdrawalManager_.requests(requestId_);
            if (owner_ == SAFE && queued_ != 0) {
                continue;
            }
            _openRequests[idx_] = _openRequests[_openRequests.length - 1];
            _openRequests.pop();
            emit RequestCleared(requestId_);
        }
        // Unpin only once this manager owes the Safe nothing at all. Shares already moved into the manual
        // bucket are still held by *this* manager, so releasing the pin while they are outstanding would let a
        // later rotation strand them outside the NAV without tripping the rotation guard.
        if (_openRequests.length == 0 && withdrawalManager_.lockedShares(SAFE) == 0) {
            _trackedWithdrawalManager = address(0);
        }
    }

    /// @dev Reverts unless the rate sits inside the accepted band, or a live guardian acknowledgement covers
    ///      it. Consuming the acknowledgement here keeps it one-shot: a persistent authorisation would turn a
    ///      one-off credit event into a standing exemption.
    /// @param rate The measured WAD-scaled rate.
    function _checkRateBand(uint256 rate) internal {
        (uint256 minRate_, uint256 maxRate_) = rateBand();
        if (rate >= minRate_ && rate <= maxRate_) {
            return;
        }

        Acknowledgement memory ack_ = _acknowledgement;
        if (ack_.expiresAt < block.timestamp || rate < ack_.minRate || rate > ack_.maxRate) {
            revert RateOutOfBand(rate, minRate_, maxRate_);
        }

        delete _acknowledgement;
        emit AcknowledgementConsumed(rate);
    }

    /// @dev Routes one call through the Roles modifier as the Safe. `shouldRevert` bubbles inner failures, so
    ///      a rejected policy check or a failing Maple call aborts the whole operation instead of leaving the
    ///      manager's accounting ahead of the Safe's state.
    /// @param target The call target.
    /// @param data The calldata.
    function _exec(address target, bytes memory data) internal {
        bool success_ = ROLES.execTransactionWithRole(target, 0, data, OPERATION_CALL, ROLE_KEY, true);
        if (!success_) {
            revert SafeExecutionFailed(target);
        }
    }

    /* ------------------------------------------------------------ INTERNAL VIEWS ------------------------------------------- */

    /// @dev Enforces the push cooldown, then the role gate with its permissionless staleness backstop.
    function _checkPushAllowed() internal view {
        uint256 lastPushAt_ = _lastPushAt;
        if (lastPushAt_ == 0) {
            // Before the first push there is no staleness to measure, so only the keeper may seed the band.
            if (!_hasPushRole()) {
                revert PushNotPermissionless(type(uint256).max);
            }
            return;
        }
        uint256 nextPushAt_ = lastPushAt_ + PUSH_COOLDOWN;
        if (block.timestamp < nextPushAt_) {
            revert PushCooldown(nextPushAt_);
        }
        uint256 permissionlessAt_ = lastPushAt_ + PERMISSIONLESS_PUSH_DELAY;
        if (block.timestamp < permissionlessAt_ && !_hasPushRole()) {
            revert PushNotPermissionless(permissionlessAt_);
        }
    }

    /// @dev The {onlyRole} body, split out so the modifier stays a one-liner at every call site.
    /// @param role The role identifier.
    function _onlyRole(bytes32 role) internal view {
        if (!_hasRole(role, msg.sender)) {
            revert MissingRole(role, address(this), msg.sender);
        }
    }

    /// @dev Whether the caller holds the push role. Read as a boolean rather than through {onlyRole} because
    ///      the absence of the role is a valid path once the valuation is stale.
    function _hasPushRole() internal view returns (bool) {
        return _hasRole(NAV_PUSH, msg.sender);
    }

    /// @dev Role lookup against the external registry, scoped to this contract.
    /// @param role The role identifier.
    /// @param account The account to check.
    function _hasRole(bytes32 role, address account) internal view returns (bool) {
        return ACCESS_CONTROL.hasRoleOrScopedRole(role, address(this), account);
    }

    /// @dev Whether a request id is in the open set. Bounded by {MAX_OPEN_REQUESTS}.
    /// @param requestId The id to look for.
    function _isTracked(uint256 requestId) internal view returns (bool) {
        uint256[] memory ids_ = _openRequests;
        uint256 length_ = ids_.length;
        for (uint256 idx_ = 0; idx_ < length_; ++idx_) {
            if (ids_[idx_] == requestId) {
                return true;
            }
        }
        return false;
    }

    /// @dev Resolves the pool's current withdrawal manager and refuses to proceed if it is not the one the
    ///      tracked requests were created against. A rotation would make every tracked id read `(0, 0)` on the
    ///      new manager, so {_prune} would drop them all and the escrow term would collapse to zero -- with the
    ///      *rate* still inside its band, so nothing would block the push. Failing closed turns a silent
    ///      understatement of arbitrary size into a liveness stop, which is the trade this contract makes
    ///      everywhere else. {resolveWithdrawalManagerRotation} is the way out.
    /// @return manager The active withdrawal manager.
    function _activeWithdrawalManager() internal view returns (ISyrupWithdrawalManager manager) {
        manager = withdrawalManager();
        address tracked_ = _trackedWithdrawalManager;
        if (tracked_ != address(0) && tracked_ != address(manager)) {
            revert WithdrawalManagerRotated(tracked_, address(manager));
        }
    }

    /// @dev The escrow term, against an already-resolved manager so a NAV read resolves it once.
    /// @param manager The withdrawal manager to read.
    /// @return shares The shares still queued across every tracked request.
    function _escrowedShares(ISyrupWithdrawalManager manager) internal view returns (uint256 shares) {
        uint256[] memory ids_ = _openRequests;
        uint256 length_ = ids_.length;
        for (uint256 idx_ = 0; idx_ < length_; ++idx_) {
            (address owner_, uint256 queued_) = manager.requests(ids_[idx_]);
            if (owner_ == SAFE) {
                shares += queued_;
            }
        }
    }

    /// @dev Requires `target` to be a non-zero address with deployed code.
    /// @param target The address to validate.
    function _requireContract(address target) private view {
        if (target == address(0) || target.code.length == 0) {
            revert InvalidContract(target);
        }
    }
}
