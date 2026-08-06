// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ILagoonValuation} from "./interfaces/ILagoonValuation.sol";
import {IMaplePool} from "./interfaces/IMaplePool.sol";
import {IRoleRegistry} from "./interfaces/IRoleRegistry.sol";
import {ISyrupPoolManager} from "./interfaces/ISyrupPoolManager.sol";
import {ISyrupRouter} from "./interfaces/ISyrupRouter.sol";
import {ISyrupWithdrawalManager} from "./interfaces/ISyrupWithdrawalManager.sol";
import {IZodiacRoles} from "./interfaces/IZodiacRoles.sol";

/// @notice Deployment parameters for a SyrupNavManager instance.
/// @dev Passed as a struct because the manager is immutable and takes eleven arguments; a positional list at
///      that width is a misconfiguration hazard on a fund-critical contract.
/// @param accessControl The external role registry that gates the keeper and guardian roles.
/// @param vault The Lagoon vault this manager is the `valuationManager` of.
/// @param roles The Zodiac Roles v2 modifier the manager executes the Safe's calls through.
/// @param roleKey The manager's role key on that modifier.
/// @param syrupRouter The Syrup router serving the target Maple pool.
/// @param depositData Maple's `bytes32` attribution tag, conventionally `0:<integrator-name>`.
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
///         2. **Lifecycle.** `deploy`, `requestRedeem` and `cancelRedeem` route the Safe's Maple calls
///            through the Zodiac Roles modifier, so withdrawal bookkeeping is a property of the code rather
///            than of keeper discipline.
///
/// @dev    **Why the escrow term is not optional.** `requestRedeem` moves pool shares out of the Safe and into
///         Maple's withdrawal manager. A NAV computed from Safe balances alone would therefore read a crash the
///         instant a redemption is requested and a spike when the assets are pushed back -- and Lagoon's
///         price-per-share guardrails would reject the settle that prices either move, deadlocking the vault
///         exactly when holders are exiting. {navComponents} values escrowed shares as a third term so the NAV
///         stays continuous across request, partial fill and full service.
///
///         **Why concurrent exits are safe here.** Maple's queue manager reports only an owner's *latest*
///         request id, and the withdrawal manager keeps no per-request payment record. A per-request holding
///         address would be needed if each request had its own claimant -- but at the Safe level that is not the
///         case: the Safe is one pooled book and Lagoon's settlement apportions the proceeds, so no attribution
///         is required. This manager records each request id as it creates it and reads status per id from
///         `requests(id)`, so several requests may be outstanding at once and exits never serialise behind one
///         another. Order carries no meaning: the escrow term is a sum, and partial fills are read from the
///         queue rather than cached.
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

    /* ------------------------------------------------------------ EVENTS --------------------------------------------------- */

    /// @dev Emitted when a NAV is proposed to the Lagoon vault. Reports the components so an indexer can
    ///      attribute a move without reading storage.
    /// @param nav The proposed total assets.
    /// @param rate The WAD-scaled exit exchange rate the NAV was computed at.
    /// @param idleAssets The Safe's idle asset balance component.
    /// @param heldAssets The exit value of the pool shares the Safe holds.
    /// @param escrowedAssets The exit value of the pool shares queued for withdrawal.
    event NavPushed(uint256 nav, uint256 rate, uint256 idleAssets, uint256 heldAssets, uint256 escrowedAssets);

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

    /// @dev Emitted when a withdrawal request is serviced in full inside the requesting transaction, so no
    ///      queue entry survives it.
    /// @param sharesRequested The shares handed to the withdrawal manager.
    /// @param assetsReceived The assets the Safe received.
    event RedeemServicedImmediately(uint256 sharesRequested, uint256 assetsReceived);

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

    /// @dev Raised when the request to cancel is not the one Maple's `removeShares` would act on. The queue
    ///      manager takes an owner and no id, resolving the removal through `requestIds(owner)` -- the owner's
    ///      *latest* entry -- so only that entry is cancellable and earlier ones must wait for the queue.
    ///      Supplying the id makes the caller state which entry it believes it is cancelling, so a stale
    ///      keeper cannot silently unwind a different one.
    /// @param requestId The id the caller asked to cancel.
    /// @param cancellableRequestId The id Maple would actually act on, 0 if none.
    error RequestNotCancellable(uint256 requestId, uint256 cancellableRequestId);

    /// @dev Raised when `requestRedeem` neither queued a new request nor delivered assets, leaving the
    ///      manager unable to account for the shares it just sent.
    error RequestNotRegistered();

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

        (uint256 idle_, uint256 held_, uint256 escrowed_) = navComponents();
        nav = idle_ + held_ + escrowed_;

        _lastRate = rate_;
        _lastPushAt = block.timestamp;
        _lastNav = nav;

        emit NavPushed(nav, rate_, idle_, held_, escrowed_);

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
        // Surfaced here rather than as the router's `SR:D:NOT_AUTHORIZED`, which is also what an
        // un-allowlisted Safe returns; `maxDeposit` distinguishes a capped pool from a permissioning gap.
        uint256 limit_ = SYRUP_POOL.maxDeposit(SAFE);
        if (assets > limit_) {
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
    /// @dev The new id is captured from `requestIds(SAFE)` immediately after the call, the only moment the
    ///      queue manager unambiguously identifies it. From then on the entry is tracked by id and read via
    ///      `requests(id)`, so the manager never depends on `requestIds` again and concurrent requests stay
    ///      distinguishable.
    ///
    ///      A returned id of 0 -- or one already tracked -- means no *new* entry survived the call: the queue
    ///      serviced this request in full inside the transaction and the assets are already in the Safe.
    ///      Treating that as a failure would revert a successful withdrawal.
    /// @param shares The pool shares to queue.
    /// @return requestId The queue entry id, or 0 if the request was serviced immediately.
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

        ISyrupWithdrawalManager withdrawalManager_ = withdrawalManager();
        uint256 assetsBefore_ = ASSET.balanceOf(SAFE);

        _exec(address(SYRUP_POOL), abi.encodeCall(IMaplePool.requestRedeem, (shares, SAFE)));

        requestId = withdrawalManager_.requestIds(SAFE);
        if (requestId == 0 || _isTracked(requestId)) {
            // Serviced in full within the call: assert the proceeds landed rather than assuming they did.
            uint256 received_ = ASSET.balanceOf(SAFE) - assetsBefore_;
            if (received_ == 0) {
                revert RequestNotRegistered();
            }
            emit RedeemServicedImmediately(shares, received_);
            return 0;
        }

        (address owner_, uint256 queued_) = withdrawalManager_.requests(requestId);
        if (owner_ != SAFE) {
            revert RequestOwnerMismatch(owner_);
        }

        _openRequests.push(requestId);

        emit RedeemRequested(requestId, shares, queued_, _openRequests.length);
    }

    /// @notice Cancels one outstanding withdrawal request, returning its shares to the Safe.
    /// @dev The escape hatch for a request stuck behind Maple's FIFO queue. Maple may honour the removal only
    ///      in part, so the open set is re-derived from the queue afterwards rather than assumed reduced.
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

        ISyrupWithdrawalManager withdrawalManager_ = withdrawalManager();

        // Maple resolves a removal through `requestIds(owner)`, so only the owner's latest entry can be
        // cancelled. Asserting the caller's expectation matches keeps a stale keeper from unwinding another.
        uint256 cancellable_ = withdrawalManager_.requestIds(SAFE);
        if (requestId != cancellable_) {
            revert RequestNotCancellable(requestId, cancellable_);
        }

        (address owner_, uint256 queued_) = withdrawalManager_.requests(requestId);
        if (owner_ != SAFE || queued_ == 0) {
            // Already serviced or removed out of band: drop it from the open set rather than calling Maple.
            _prune();
            revert UnknownRequest(requestId);
        }

        uint256 sharesBefore_ = SYRUP_POOL.balanceOf(SAFE);

        _exec(address(SYRUP_POOL), abi.encodeCall(IMaplePool.removeShares, (queued_, SAFE)));

        sharesReturned = SYRUP_POOL.balanceOf(SAFE) - sharesBefore_;
        if (sharesReturned == 0) {
            revert NoSharesReturned();
        }

        // Re-derive rather than delete: a partial removal leaves the entry live with fewer shares.
        _prune();

        emit RedeemCancelled(requestId, sharesReturned);
    }

    /// @notice Drops request ids the withdrawal manager no longer reports as outstanding.
    /// @dev Permissionless, and the reason serviced requests cannot hold slots under {MAX_OPEN_REQUESTS}
    ///      while the keeper is down.
    function pruneRequests() external {
        _prune();
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

    /// @notice The only open request {cancelRedeem} could currently act on.
    /// @dev Mirrors Maple's `requestIds(SAFE)`, and is 0 when nothing is cancellable -- including the case
    ///      where earlier entries are still queued but the latest has already been serviced.
    /// @return requestId The cancellable request id, 0 if none.
    function cancellableRequest() external view returns (uint256 requestId) {
        return withdrawalManager().requestIds(SAFE);
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
        (uint256 idle_, uint256 held_, uint256 escrowed_) = navComponents();
        return idle_ + held_ + escrowed_;
    }

    /// @notice The three components of the NAV, broken out so a keeper or indexer can attribute a move.
    /// @dev All pool-share valuation goes through `convertToExitAssets`, never `convertToAssets`: the exit
    ///      variant applies the pool's unrealized-loss haircut, so the figure is what a redeemer would
    ///      actually receive rather than an optimistic mark. Escrowed shares are summed first and converted
    ///      once, so splitting one exit across several requests cannot change the valuation.
    /// @return idleAssets The Safe's undeployed asset balance.
    /// @return heldAssets The exit value of the pool shares the Safe holds.
    /// @return escrowedAssets The exit value of the pool shares queued for withdrawal.
    function navComponents() public view returns (uint256 idleAssets, uint256 heldAssets, uint256 escrowedAssets) {
        idleAssets = ASSET.balanceOf(SAFE);
        heldAssets = SYRUP_POOL.convertToExitAssets(SYRUP_POOL.balanceOf(SAFE));
        escrowedAssets = SYRUP_POOL.convertToExitAssets(escrowedShares());
    }

    /// @notice The pool shares still awaiting service across every open request.
    /// @dev Reads each entry from the queue rather than trusting stored share counts, because the pool
    ///      delegate shrinks `requests(id).shares` in place on a partial fill. The `owner == SAFE` check means
    ///      a cleared, reassigned or foreign entry contributes nothing instead of inflating the NAV. Bounded
    ///      by {MAX_OPEN_REQUESTS}.
    /// @return shares The shares still queued, 0 when nothing is outstanding.
    function escrowedShares() public view returns (uint256 shares) {
        uint256[] memory ids_ = _openRequests;
        uint256 length_ = ids_.length;
        if (length_ == 0) {
            return 0;
        }
        ISyrupWithdrawalManager withdrawalManager_ = withdrawalManager();
        for (uint256 idx_ = 0; idx_ < length_; ++idx_) {
            (address owner_, uint256 queued_) = withdrawalManager_.requests(ids_[idx_]);
            if (owner_ == SAFE) {
                shares += queued_;
            }
        }
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

    /// @notice The exchange-rate band the next push would accept.
    /// @dev Exposed so a keeper can tell a refused push apart from a rate that has genuinely left the band,
    ///      and page a guardian instead of retrying.
    /// @return minRate The lowest accepted rate, WAD-scaled.
    /// @return maxRate The highest accepted rate, WAD-scaled.
    function rateBand() public view returns (uint256 minRate, uint256 maxRate) {
        uint256 lastRate_ = _lastRate;
        if (lastRate_ == 0) {
            return (0, type(uint256).max);
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
        ISyrupWithdrawalManager withdrawalManager_ = withdrawalManager();
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

    /// @dev Requires `target` to be a non-zero address with deployed code.
    /// @param target The address to validate.
    function _requireContract(address target) private view {
        if (target == address(0) || target.code.length == 0) {
            revert InvalidContract(target);
        }
    }
}
