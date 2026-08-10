// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZacForkTest} from "zac-test/ZacForkTest.sol";

import {DeploymentParams, SyrupNavManager} from "src/SyrupNavManager.sol";
import {ILagoonValuation} from "src/interfaces/ILagoonValuation.sol";
import {IMaplePool} from "src/interfaces/IMaplePool.sol";
import {IPoolPermissionManager} from "src/interfaces/IPoolPermissionManager.sol";
import {IRoleRegistry} from "src/interfaces/IRoleRegistry.sol";
import {ISyrupRouter} from "src/interfaces/ISyrupRouter.sol";
import {ISyrupWithdrawalManager} from "src/interfaces/ISyrupWithdrawalManager.sol";
import {IZodiacRoles} from "src/interfaces/IZodiacRoles.sol";

import {USDC} from "./chainConfigs/MainnetAddresses.sol";

/* ---------------------------------------------------------------- LIVE ADDRESSES ------------------------------------- */

/// @dev syrupUSDC pool. Confirmed by `symbol() == "syrupUSDC"`, `decimals() == 6`.
address constant SYRUP_USDC = 0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b;

/// @dev Maple `PoolManager` for syrupUSDC. Confirmed by `pool.manager()`.
address constant MAPLE_POOL_MANAGER = 0x7aD5fFa5fdF509E30186F4609c2f6269f4B6158F;

/// @dev Maple withdrawal manager (`withdrawal-manager-queue` v2.0.0). Confirmed by
///      `poolManager.withdrawalManager()` and by the v2-only surface asserted in
///      {SyrupNavManagerForkTest.test_fork_withdrawalManagerIsQueueV2}.
address constant SYRUP_WITHDRAWAL_MANAGER = 0x1bc47a0Dd0FdaB96E9eF982fdf1F34DC6207cfE3;

/// @dev `SyrupRouter` serving syrupUSDC. Confirmed by `pool()`, `poolManager()`, `poolPermissionManager()`
///      and `asset()` all matching the addresses here.
address constant SYRUP_ROUTER = 0x134cCaaA4F1e4552eC8aEcb9E4A2360dDcF8df76;

/// @dev Maple `PoolPermissionManager`. Confirmed by `permissionLevels(poolManager) == 1` (FUNCTION_LEVEL).
address constant POOL_PERMISSION_MANAGER = 0xBe10aDcE8B6E3E02Db384E7FaDA5395DD113D8b3;

/* ---------------------------------------------------------------- FORK-ONLY VIEWS ------------------------------------ */

/// @notice Reads of the live pool that `src/interfaces/IMaplePool.sol` deliberately omits, plus the
///         `removeShares` path this test proves is unavailable.
interface IMaplePoolReads {
    function symbol() external view returns (string memory symbol_);
    function totalSupply() external view returns (uint256 totalSupply_);
    function totalAssets() external view returns (uint256 totalAssets_);
    function unrealizedLosses() external view returns (uint256 unrealizedLosses_);
    function removeShares(uint256 shares_, address owner_) external returns (uint256 sharesReturned_);
}

/// @notice The pool manager reads used to prove `maxDeposit == 0` is the permission term, and to find the
///         account allowed to service the queue.
interface IMaplePoolManagerReads {
    function poolDelegate() external view returns (address poolDelegate_);
    function liquidityCap() external view returns (uint256 liquidityCap_);
    function totalAssets() external view returns (uint256 totalAssets_);
}

/// @notice The permission-manager surface needed to read the live configuration and to onboard the Safe the
///         way Maple's own admin would.
interface IPoolPermissionManagerAdmin {
    function admin() external view returns (address admin_);
    function permissionLevels(address poolManager_) external view returns (uint256 permissionLevel_);
    function poolBitmaps(address poolManager_, bytes32 functionId_) external view returns (uint256 bitmap_);
    function lenderAllowlist(address poolManager_, address lender_) external view returns (bool allowed_);
    function setLenderAllowlist(address poolManager_, address[] calldata lenders_, bool[] calldata booleans_) external;
}

/// @notice The withdrawal-manager surface beyond `ISyrupWithdrawalManager`: the queue cursor, the escrow
///         accounting, and the delegate-only servicing entry points.
interface ISyrupWithdrawalManagerFork {
    function queue() external view returns (uint128 nextRequestId_, uint128 lastRequestId_);
    function totalShares() external view returns (uint256 totalShares_);
    function manualSharesAvailable(address owner_) external view returns (uint256 shares_);
    function processRedemptions(uint256 maxSharesToProcess_) external;
    function setManualWithdrawal(address owner_, bool isManual_) external;
}

/// @notice The owner-gated Zodiac Roles v2 calls used to authorise the manager on the fresh modifier.
/// @dev Selectors verified present in the deployed mastercopy `0x9646fDAD06d3e24444381f44362a3B0eB343D337`.
interface IZodiacRolesAdmin {
    function enableModule(address module) external;
    function assignRoles(address module, bytes32[] calldata roleKeys, bool[] calldata memberOf) external;
    function allowTarget(bytes32 roleKey, address targetAddress, uint8 options) external;
}

/* ---------------------------------------------------------------- STAND-INS ----------------------------------------- */

/// @notice A minimal `ILagoonValuation` implementation standing in for the Lagoon vault.
/// @dev Deliberately local to this file rather than under `test/mocks/`: nothing about the Lagoon side is
///      under test here, it only has to satisfy the manager's constructor cross-checks (`safe()`, `asset()`)
///      and record what `pushNav` proposes.
contract LagoonVaultStandIn is ILagoonValuation {
    address internal immutable SAFE_;
    address internal immutable ASSET_;

    uint256 public lastProposed;
    uint256 public proposalCount;

    constructor(address safe_, address asset_) {
        SAFE_ = safe_;
        ASSET_ = asset_;
    }

    function updateNewTotalAssets(uint256 newTotalAssets) external {
        lastProposed = newTotalAssets;
        ++proposalCount;
    }

    function isTotalAssetsValid() external pure returns (bool valid) {
        return true;
    }

    function asset() external view returns (address asset_) {
        return ASSET_;
    }

    function safe() external view returns (address safe_) {
        return SAFE_;
    }
}

/// @notice A minimal `IRoleRegistry` granting every manager role to one operator.
contract ForkRoleRegistry is IRoleRegistry {
    address public immutable OPERATOR;

    constructor(address operator_) {
        OPERATOR = operator_;
    }

    function hasRoleOrScopedRole(bytes32, address, address account) external view returns (bool held) {
        return account == OPERATOR;
    }
}

/* ---------------------------------------------------------------- TEST --------------------------------------------- */

/// @title  SyrupNavManagerForkTest
/// @notice Pinned-block mainnet fork test for `SyrupNavManager` against the real Maple (Syrup) protocol.
///
/// @dev    The unit suite runs against mocks written from the same reading of Maple that produced the
///         contract, so a misreading is invisible there by construction. This file is the independent check:
///         every assumption the valuation rests on is asserted against the deployed pool, pool manager,
///         withdrawal manager and permission manager.
///
///         Runs under `FOUNDRY_PROFILE=contracts-fork` with `MAINNET_RPC_URL` set:
///         `FOUNDRY_PROFILE=contracts-fork forge test --match-path 'test/fork/SyrupNavManagerFork.t.sol' -vv`
///
///         Safe + Roles v2 modifier come from `ZacForkTest.deployRolesFixture`; the policy is not rendered by
///         the ZAC CLI here (that is what `test/fork/templates/` does), the modifier is instead authorised
///         directly so the subject under test is the manager rather than the policy.
contract SyrupNavManagerForkTest is ZacForkTest {
    /// @dev Pinned for determinism: every assertion below is about state at this exact block, so the file must
    ///      not drift with head. Chosen at or below the block the review's on-chain facts were read at.
    uint256 constant PINNED_BLOCK = 25_723_916;

    /// @dev Maple's ASCII function identifiers, as `PoolPermissionManager` compares them.
    // casting to 'bytes32' is safe because each literal is a short ASCII string, far inside 32 bytes, and
    // right-padding is exactly the encoding Maple's `hasPermission` compares against.
    // forge-lint: disable-start(unsafe-typecast)
    bytes32 constant P_DEPOSIT = bytes32("P:deposit");
    bytes32 constant P_REMOVE_SHARES = bytes32("P:removeShares");
    bytes32 constant P_REQUEST_REDEEM = bytes32("P:requestRedeem");
    bytes32 constant P_REDEEM = bytes32("P:redeem");
    // forge-lint: disable-end(unsafe-typecast)

    /// @dev Maple's `FUNCTION_LEVEL` permission level.
    uint256 constant FUNCTION_LEVEL = 1;

    /// @dev The pool bitmap syrupUSDC carries for both `P:deposit` and `P:removeShares`.
    uint256 constant GATED_BITMAP = 16;

    /// @dev One whole syrupUSDC share / one whole USDC (both 6 decimals).
    uint256 constant ONE_UNIT = 1e6;

    /// @dev The exit rate of one whole share at {PINNED_BLOCK}, in assets.
    uint256 constant PINNED_EXIT_ASSETS_PER_SHARE = 1_177_603;

    /// @dev USDC dealt to the Safe, and the slice of it deployed into the pool.
    uint256 constant SAFE_USDC = 250_000e6;
    uint256 constant DEPLOY_ASSETS = 100_000e6;

    /// @dev NAV continuity tolerance, in USDC units — two millionths of a USDC on a 250,000 USDC book. Every
    ///      continuity assertion below except the deposit leg is exact at zero tolerance against the live
    ///      pool; the deposit leg loses one unit to Maple's floor division. The failure being guarded against
    ///      is the NAV dropping by the *whole* escrowed position, eleven orders of magnitude above this.
    uint256 constant NAV_TOLERANCE = 2;

    /// @dev Zodiac role key the manager executes the Safe's calls under.
    bytes32 constant ROLE_KEY = keccak256("SYRUP_NAV_MANAGER_FORK");

    /// @dev The keeper/guardian in {registry}: holds every manager role.
    address constant OPERATOR = 0x1111111111111111111111111111111111111111;

    /// @dev An address Maple has never onboarded, used for the permission-term assertions.
    address constant STRANGER = 0x000000000000000000000000000000000000dEaD;

    IMaplePool internal pool = IMaplePool(SYRUP_USDC);
    IMaplePoolReads internal poolReads = IMaplePoolReads(SYRUP_USDC);
    IMaplePoolManagerReads internal poolManager = IMaplePoolManagerReads(MAPLE_POOL_MANAGER);
    ISyrupWithdrawalManager internal wm = ISyrupWithdrawalManager(SYRUP_WITHDRAWAL_MANAGER);
    ISyrupWithdrawalManagerFork internal wmFork = ISyrupWithdrawalManagerFork(SYRUP_WITHDRAWAL_MANAGER);
    IPoolPermissionManagerAdmin internal ppm = IPoolPermissionManagerAdmin(POOL_PERMISSION_MANAGER);
    IERC20 internal usdc = IERC20(USDC);

    SyrupNavManager internal manager;
    LagoonVaultStandIn internal vault;
    ForkRoleRegistry internal registry;

    address internal safe;
    address internal rolesModifier;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), PINNED_BLOCK);

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), OPERATOR);
        safe = fx.safe;
        rolesModifier = fx.modifier_;

        vault = new LagoonVaultStandIn(safe, USDC);
        registry = new ForkRoleRegistry(OPERATOR);

        manager = new SyrupNavManager(
            DeploymentParams({
                accessControl: IRoleRegistry(address(registry)),
                vault: ILagoonValuation(address(vault)),
                roles: IZodiacRoles(rolesModifier),
                roleKey: ROLE_KEY,
                syrupRouter: ISyrupRouter(SYRUP_ROUTER),
                // casting to 'bytes32' is safe because the literal is a 14-byte ASCII attribution tag.
                // forge-lint: disable-next-line(unsafe-typecast)
                depositData: bytes32("0:railnet-fork"),
                // Anchored on the live exit rate at {PINNED_BLOCK}. The tolerance is wider than a production
                // deployment would use because the servicing tests deal USDC into the pool to buy queue
                // liquidity, which lifts the rate by ~2%.
                initialRate: (PINNED_EXIT_ASSETS_PER_SHARE * 1e18) / ONE_UNIT,
                initialRateToleranceBps: 500,
                maxRateGrowthPerSecond: 1e10,
                maxRateDropBps: 100,
                pushCooldown: 1 hours,
                permissionlessPushDelay: 1 days,
                maxOpenRequests: 8
            })
        );

        // The Safe owns the modifier, so it is the authority for both calls: enable the manager as a module
        // (the `moduleOnly` gate on `execTransactionWithRole`) and give it the role its calls run under.
        _authoriseManagerOnModifier();

        // Onboard the Safe the way Maple's own admin does. `lenderAllowlist` is used rather than
        // `vm.store`/`vm.mockCall` because the admin path is a real, unforged state transition: the
        // permission reads downstream (`Pool.maxDeposit`, `SyrupRouter._deposit`, `PoolManager.canCall`) then
        // exercise the deployed logic rather than a stub.
        _setSafeAllowlisted(true);

        deal(USDC, safe, SAFE_USDC);
    }

    /* ------------------------------------------------------------ 1. PROTOCOL SHAPE ------------------------------ */

    /// Pins the permission model the escrow term and the cancellation primitive rest on: syrupUSDC is
    /// function-level permissioned, `P:deposit` and `P:removeShares` share one bitmap (so revoking deposits
    /// revokes pool-side cancellation with it), while `P:requestRedeem` and `P:redeem` are open to everyone.
    function test_fork_permissionLevelIsFunctionLevelAndDepositSharesItsBitmapWithRemoveShares() public view {
        assertEq(ppm.permissionLevels(MAPLE_POOL_MANAGER), FUNCTION_LEVEL, "pool is not FUNCTION_LEVEL");

        assertEq(ppm.poolBitmaps(MAPLE_POOL_MANAGER, P_DEPOSIT), GATED_BITMAP, "P:deposit bitmap");
        assertEq(ppm.poolBitmaps(MAPLE_POOL_MANAGER, P_REMOVE_SHARES), GATED_BITMAP, "P:removeShares bitmap");
        assertEq(ppm.poolBitmaps(MAPLE_POOL_MANAGER, P_REQUEST_REDEEM), 0, "P:requestRedeem bitmap");
        assertEq(ppm.poolBitmaps(MAPLE_POOL_MANAGER, P_REDEEM), 0, "P:redeem bitmap");

        // The reason H3/H2(b) matter: one bitmap gates both, so the two permissions cannot be held apart.
        assertEq(
            ppm.poolBitmaps(MAPLE_POOL_MANAGER, P_DEPOSIT),
            ppm.poolBitmaps(MAPLE_POOL_MANAGER, P_REMOVE_SHARES),
            "deposit and removeShares no longer share a bitmap"
        );

        // A zero pool bitmap passes `(poolBitmap & lenderBitmap) == poolBitmap` for everyone.
        IPoolPermissionManager reader = IPoolPermissionManager(POOL_PERMISSION_MANAGER);
        assertTrue(reader.hasPermission(MAPLE_POOL_MANAGER, STRANGER, P_REQUEST_REDEEM), "requestRedeem gated");
        assertTrue(reader.hasPermission(MAPLE_POOL_MANAGER, STRANGER, P_REDEEM), "redeem gated");
        assertFalse(reader.hasPermission(MAPLE_POOL_MANAGER, STRANGER, P_DEPOSIT), "deposit ungated");
        assertFalse(reader.hasPermission(MAPLE_POOL_MANAGER, STRANGER, P_REMOVE_SHARES), "removeShares ungated");
    }

    /// Pins that a zero `maxDeposit` is the permission term and not capacity — the distinction
    /// `deploy` reports as `NotAllowlisted` versus `DepositExceedsPoolLimit`.
    function test_fork_maxDepositZeroIsThePermissionTermNotCapacity() public {
        uint256 liquidityCap = poolManager.liquidityCap();
        uint256 totalAssets = poolManager.totalAssets();
        assertGt(liquidityCap, totalAssets, "pool is at its liquidity cap, so the zero is capacity");

        assertEq(pool.maxDeposit(STRANGER), 0, "un-onboarded address has non-zero maxDeposit");
        assertTrue(manager.isDepositAllowlisted(), "Safe should be allowlisted by setUp");

        // Same address, same capacity, allowlist flipped: the zero moves with the permission alone.
        assertEq(pool.maxDeposit(safe), liquidityCap - totalAssets, "allowlisted Safe sees full headroom");
        _setSafeAllowlisted(false);
        assertEq(pool.maxDeposit(safe), 0, "de-allowlisted Safe still sees headroom");
        assertFalse(manager.isDepositAllowlisted(), "isDepositAllowlisted disagrees with the allowlist");
    }

    /// Pins the deployed withdrawal manager as queue v2.0.0: the four getters v1.0.0 does not have answer,
    /// `removeSharesById` exists and is owner-authenticated, and the queue cursor is a live FIFO.
    function test_fork_withdrawalManagerIsQueueV2() public {
        assertEq(pool.manager(), MAPLE_POOL_MANAGER, "pool.manager() moved");
        assertEq(address(manager.withdrawalManager()), SYRUP_WITHDRAWAL_MANAGER, "withdrawal manager moved");

        // v2-only surface. These four selectors do not exist in v1.0.0, so a successful call is the version.
        assertEq(wm.userEscrowedShares(STRANGER), 0, "userEscrowedShares");
        assertEq(wm.lockedShares(STRANGER), 0, "lockedShares");
        (uint256[] memory ids, uint256[] memory shares) = wm.requestsByOwner(STRANGER);
        assertEq(ids.length, 0, "requestsByOwner ids");
        assertEq(shares.length, 0, "requestsByOwner shares");
        assertFalse(wm.isManualWithdrawal(STRANGER), "isManualWithdrawal");

        // Request 1 was serviced and deleted years of blocks ago, so the id is invalid rather than foreign.
        vm.expectRevert(bytes("WM:RSBI:INVALID_REQUEST"));
        wm.removeSharesById(1, 1);

        // A live, non-empty FIFO: ids are minted `++lastRequestId`, and the cursor trails behind it.
        (uint128 nextRequestId, uint128 lastRequestId) = wmFork.queue();
        assertGt(lastRequestId, 0, "queue has never issued an id");
        assertLe(nextRequestId, lastRequestId, "cursor is past the last issued id");
    }

    /// Pins that valuation and payout use the same arithmetic: `convertToExitAssets` is exactly the
    /// withdrawal manager's `_calculateRedemption` payout formula, and equals `convertToAssets` only because
    /// `unrealizedLosses() == 0` today.
    function test_fork_exitConversionEqualsWithdrawalManagerPayoutFormula() public view {
        assertEq(poolReads.symbol(), "syrupUSDC", "wrong pool");
        assertEq(pool.decimals(), 6, "pool decimals");
        assertEq(poolReads.unrealizedLosses(), 0, "pool has recognised losses at this block");

        assertEq(pool.convertToExitAssets(ONE_UNIT), PINNED_EXIT_ASSETS_PER_SHARE, "exit rate drifted");
        assertEq(pool.convertToExitAssets(ONE_UNIT), pool.convertToAssets(ONE_UNIT), "exit != plain at zero losses");

        // `MapleWithdrawalManager._calculateRedemption`:
        //   resultingAssets = (totalAssets - unrealizedLosses) * shares / totalSupply
        uint256 shares = 12_345e6;
        uint256 payoutFormula =
            ((poolReads.totalAssets() - poolReads.unrealizedLosses()) * shares) / poolReads.totalSupply();
        assertEq(pool.convertToExitAssets(shares), payoutFormula, "valuation and payout formulas differ");
    }

    /// Pins the on-chain fact the escrow term depends on: queued shares are *moved*, not burned. The
    /// withdrawal manager's balance equals its own `totalShares` accounting and is part of `totalSupply`, so
    /// a queued position keeps earning until it is serviced.
    function test_fork_escrowedSharesStayInTotalSupply() public {
        uint256 wmBalance = pool.balanceOf(SYRUP_WITHDRAWAL_MANAGER);
        uint256 totalSupply = poolReads.totalSupply();

        assertGt(wmBalance, 0, "no shares escrowed at this block");
        assertEq(wmBalance, wmFork.totalShares(), "WM balance diverges from its escrow accounting");
        assertLt(wmBalance, totalSupply, "escrowed shares are not inside totalSupply");

        // And a fresh request adds to both, burning nothing.
        uint256 shares = _deployIntoPool(DEPLOY_ASSETS) / 2;
        uint256 supplyBefore = poolReads.totalSupply();

        _requestRedeem(shares);

        assertEq(poolReads.totalSupply(), supplyBefore, "requestRedeem burned shares");
        assertEq(pool.balanceOf(SYRUP_WITHDRAWAL_MANAGER), wmBalance + shares, "WM did not receive the shares");
        assertEq(wmFork.totalShares(), wmBalance + shares, "WM escrow accounting did not follow");
    }

    /// Pins that the manager's constructor cross-checks pass against the live contracts, and that its views
    /// resolve the real Maple graph rather than a configured guess.
    function test_fork_managerWiringResolvesLiveMapleContracts() public view {
        assertEq(address(manager.SYRUP_POOL()), SYRUP_USDC, "pool");
        assertEq(address(manager.SYRUP_ROUTER()), SYRUP_ROUTER, "router");
        assertEq(address(manager.ASSET()), USDC, "asset");
        assertEq(manager.SAFE(), safe, "safe");
        assertEq(address(manager.withdrawalManager()), SYRUP_WITHDRAWAL_MANAGER, "withdrawal manager");
        assertTrue(manager.isDepositAllowlisted(), "Safe not allowlisted");

        (bool rotated, address tracked, address current) = manager.withdrawalManagerRotated();
        assertFalse(rotated, "rotation pending with nothing tracked");
        assertEq(tracked, address(0), "manager pinned before any request");
        assertEq(current, SYRUP_WITHDRAWAL_MANAGER, "current manager");

        (bool cooldownElapsed, bool permissionless, bool valuationValid) = manager.pushStatus();
        assertTrue(cooldownElapsed, "first push should not be on cooldown");
        assertFalse(permissionless, "first push must not be permissionless");
        assertTrue(valuationValid, "vault stand-in reports its valuation valid");

        assertEq(manager.exchangeRate(), (PINNED_EXIT_ASSETS_PER_SHARE * 1e18) / ONE_UNIT, "exchange rate");
    }

    /* ------------------------------------------------------------ 2. FULL LIFECYCLE ------------------------------ */

    /// The whole point of the contract, against the live pool: NAV is continuous across
    /// `deploy -> requestRedeem -> service`, and in particular does NOT drop when `requestRedeem` moves the
    /// shares off the Safe.
    function test_fork_navIsContinuousAcrossDeployRequestAndService() public {
        // Buy the queue its liquidity up front, so the rate lift it causes lands before the first snapshot.
        // `DEPLOY_ASSETS` is an upper bound on the shares this test can ever hold (the rate is > 1).
        _prefundQueueLiquidity(DEPLOY_ASSETS);

        uint256 navIdle = manager.previewNav();
        assertEq(navIdle, SAFE_USDC, "idle NAV is the Safe's USDC balance");

        // --- deploy -------------------------------------------------------------------------------------
        uint256 shares = _deployIntoPool(DEPLOY_ASSETS);
        assertGt(shares, 0, "no shares minted");

        uint256 navDeployed = manager.previewNav();
        assertApproxEqAbs(navDeployed, navIdle, NAV_TOLERANCE, "NAV moved when assets became shares");

        (uint256 idle, uint256 held, uint256 escrowed, uint256 manual) = manager.navComponents();
        assertEq(idle, SAFE_USDC - DEPLOY_ASSETS, "idle term");
        assertApproxEqAbs(held, DEPLOY_ASSETS, NAV_TOLERANCE, "held term");
        assertEq(escrowed, 0, "escrow term before any request");
        assertEq(manual, 0, "manual term before any request");

        // --- requestRedeem: the shares leave the Safe -----------------------------------------------------
        uint256 requestShares = shares / 2;
        uint256 requestId = _requestRedeem(requestShares);

        assertEq(pool.balanceOf(safe), shares - requestShares, "shares did not leave the Safe");

        uint256 navRequested = manager.previewNav();
        assertApproxEqAbs(navRequested, navDeployed, NAV_TOLERANCE, "NAV dropped when shares were escrowed");

        (idle, held, escrowed, manual) = manager.navComponents();
        assertEq(escrowed, pool.convertToExitAssets(requestShares), "escrow term does not value the queue entry");
        assertEq(manual, 0, "manual term after a plain request");

        // --- service the queue --------------------------------------------------------------------------
        uint256 safeAssetsBefore = usdc.balanceOf(safe);
        _serviceQueue(requestId, requestShares);

        (address owner, uint256 queued) = wm.requests(requestId);
        assertEq(owner, address(0), "request survived full service");
        assertEq(queued, 0, "request still reports queued shares");
        assertGt(usdc.balanceOf(safe), safeAssetsBefore, "Safe received no assets");

        uint256 navServiced = manager.previewNav();
        assertApproxEqAbs(navServiced, navRequested, NAV_TOLERANCE, "NAV jumped when the queue paid out");

        manager.pruneRequests();
        assertEq(manager.openRequests().length, 0, "serviced request still holds a slot");
        assertEq(manager.escrowedShares(), 0, "escrow term outlived the request");

        // --- and the manager can price the live book to the vault ---------------------------------------
        vm.prank(OPERATOR);
        uint256 pushed = manager.pushNav();
        assertApproxEqAbs(pushed, navServiced, NAV_TOLERANCE, "pushed NAV disagrees with previewNav");
        assertEq(vault.lastProposed(), pushed, "vault did not receive the proposal");
        assertEq(vault.proposalCount(), 1, "vault received the wrong number of proposals");
    }

    /* ------------------------------------------------------------ 3. QUEUE MECHANICS ----------------------------- */

    /// Pins that there is no immediate-service path: `requestRedeem` against the live queue ALWAYS leaves an
    /// entry, under a fresh id strictly greater than every id the queue has ever issued.
    function test_fork_requestRedeemAlwaysLeavesAQueueEntry() public {
        uint256 shares = _deployIntoPool(DEPLOY_ASSETS);

        (, uint128 lastIdBefore) = wmFork.queue();

        uint256 requestId = _requestRedeem(shares);

        assertGt(requestId, lastIdBefore, "id is not strictly greater than every id ever issued");
        assertEq(requestId, uint256(lastIdBefore) + 1, "queue did not append `++lastRequestId`");
        assertEq(wm.requestIds(safe), requestId, "requestIds does not report the Safe's newest id");

        (address owner, uint256 queued) = wm.requests(requestId);
        assertEq(owner, safe, "entry is not owned by the Safe");
        assertEq(queued, shares, "entry does not hold the full request");
        assertEq(wm.userEscrowedShares(safe), shares, "escrow accounting");
        assertEq(wm.lockedShares(safe), 0, "nothing should be in the manual bucket");

        assertEq(manager.openRequests().length, 1, "manager tracks the wrong number of requests");
        assertEq(manager.openRequests()[0], requestId, "manager tracked the wrong id");
        assertEq(manager.escrowedShares(), shares, "manager's escrow term");
    }

    /// Pins that a partial fill shrinks `requests(id).shares` in place under the SAME id — the reason the
    /// escrow term is read from the queue on every NAV rather than cached at request time.
    function test_fork_partialFillShrinksTheSameRequestInPlace() public {
        _prefundQueueLiquidity(DEPLOY_ASSETS);

        uint256 shares = _deployIntoPool(DEPLOY_ASSETS);
        uint256 requestId = _requestRedeem(shares);

        uint256 navBefore = manager.previewNav();
        uint256 fill = shares / 4;

        _serviceQueue(requestId, fill);

        (address owner, uint256 queued) = wm.requests(requestId);
        assertEq(owner, safe, "partial fill reassigned or cleared the entry");
        assertEq(queued, shares - fill, "remaining shares are not the request minus the fill");
        assertEq(wm.requestIds(safe), requestId, "id changed across a partial fill");
        assertEq(manager.openRequests().length, 1, "manager lost or duplicated the request");
        assertEq(manager.openRequests()[0], requestId, "manager re-tracked a different id");
        assertEq(manager.escrowedShares(), shares - fill, "escrow term did not follow the partial fill");

        // The filled slice arrived as assets, the rest is still valued as escrow: NAV is unmoved.
        assertApproxEqAbs(manager.previewNav(), navBefore, NAV_TOLERANCE, "NAV moved across a partial fill");
    }

    /// Pins that one owner may hold several concurrent requests and that `requestsByOwner` enumerates all of
    /// them, oldest first, each with its own remaining shares.
    function test_fork_requestsByOwnerEnumeratesConcurrentRequests() public {
        uint256 shares = _deployIntoPool(DEPLOY_ASSETS);
        uint256 slice = shares / 4;

        uint256 first = _requestRedeem(slice);
        uint256 second = _requestRedeem(slice * 2);
        uint256 third = _requestRedeem(slice);

        assertGt(second, first, "ids are not strictly increasing");
        assertGt(third, second, "ids are not strictly increasing");

        (uint256[] memory ids, uint256[] memory queued) = wm.requestsByOwner(safe);
        assertEq(ids.length, 3, "requestsByOwner lost a concurrent request");
        assertEq(queued.length, ids.length, "requestsByOwner arrays disagree");

        assertEq(ids[0], first, "first id");
        assertEq(ids[1], second, "second id");
        assertEq(ids[2], third, "third id");
        assertEq(queued[0], slice, "first request shares");
        assertEq(queued[1], slice * 2, "second request shares");
        assertEq(queued[2], slice, "third request shares");

        assertEq(wm.userEscrowedShares(safe), slice * 4, "aggregate escrow accounting");

        uint256[] memory tracked = manager.openRequests();
        assertEq(tracked.length, 3, "manager tracks the wrong number of requests");
        assertEq(tracked[0], first, "manager id 0");
        assertEq(tracked[1], second, "manager id 1");
        assertEq(tracked[2], third, "manager id 2");
        assertEq(manager.escrowedShares(), slice * 4, "escrow term is not the sum of the entries");

        // Order carries no meaning: cancelling the middle entry leaves the other two untouched.
        vm.prank(OPERATOR);
        manager.cancelRedeem(second);

        (ids, queued) = wm.requestsByOwner(safe);
        assertEq(ids.length, 2, "cancelling the middle entry disturbed the others");
        assertEq(ids[0], first, "first id after cancel");
        assertEq(ids[1], third, "third id after cancel");
        assertEq(manager.escrowedShares(), slice * 2, "escrow term after cancel");
    }

    /* ------------------------------------------------------------ 4. CANCELLATION -------------------------------- */

    /// The reason the contract cancels through `removeSharesById` instead of `Pool.removeShares`: with the
    /// Safe's `P:removeShares` permission FALSE — the state Maple leaves it in the moment it revokes deposit
    /// rights — the pool-side primitive is dead while `cancelRedeem` still returns the shares.
    function test_fork_cancelRedeemWorksWithoutRemoveSharesPermission() public {
        uint256 shares = _deployIntoPool(DEPLOY_ASSETS);
        uint256 requestId = _requestRedeem(shares);

        // Maple revokes the Safe. `P:requestRedeem` stays open (bitmap 0), `P:removeShares` does not.
        _setSafeAllowlisted(false);

        IPoolPermissionManager reader = IPoolPermissionManager(POOL_PERMISSION_MANAGER);
        assertFalse(reader.hasPermission(MAPLE_POOL_MANAGER, safe, P_REMOVE_SHARES), "removeShares still permitted");
        assertFalse(reader.hasPermission(MAPLE_POOL_MANAGER, safe, P_DEPOSIT), "deposit still permitted");

        // The pool-side primitive the contract used to use is now unreachable for the Safe.
        vm.prank(safe);
        vm.expectRevert(bytes("PM:CC:NOT_ALLOWED"));
        poolReads.removeShares(shares, safe);

        // The unprivileged, owner-authenticated one is not.
        uint256 navBefore = manager.previewNav();
        uint256 safeSharesBefore = pool.balanceOf(safe);

        vm.prank(OPERATOR);
        uint256 returned = manager.cancelRedeem(requestId);

        assertEq(returned, shares, "cancel did not return the whole entry");
        assertEq(pool.balanceOf(safe), safeSharesBefore + shares, "shares did not come back to the Safe");

        (address owner, uint256 queued) = wm.requests(requestId);
        assertEq(owner, address(0), "cancelled entry survived");
        assertEq(queued, 0, "cancelled entry still reports shares");
        assertEq(wm.userEscrowedShares(safe), 0, "escrow accounting after cancel");
        assertEq(manager.openRequests().length, 0, "cancelled request still holds a slot");
        assertApproxEqAbs(manager.previewNav(), navBefore, NAV_TOLERANCE, "NAV moved across a cancel");
    }

    /* ------------------------------------------------------------ 5. MANUAL WITHDRAWAL --------------------------- */

    /// Pins the state the fourth NAV term exists for: with `isManualWithdrawal[Safe]` set, servicing deletes
    /// the queue entry WITHOUT moving assets — the shares sit on the withdrawal manager as `lockedShares`.
    /// A three-term NAV would crater by the whole escrow here; `manualShares` keeps it continuous and
    /// `redeemManual` drains it.
    function test_fork_manualWithdrawalKeepsNavContinuousAndRedeemManualDrainsIt() public {
        _prefundQueueLiquidity(DEPLOY_ASSETS);

        uint256 shares = _deployIntoPool(DEPLOY_ASSETS);
        uint256 requestId = _requestRedeem(shares);

        // v2.0.0 lets the delegate flag an owner while a request is already open.
        vm.prank(poolManager.poolDelegate());
        wmFork.setManualWithdrawal(safe, true);
        assertTrue(wm.isManualWithdrawal(safe), "delegate could not flag the Safe mid-request");

        uint256 navBefore = manager.previewNav();
        uint256 safeAssetsBefore = usdc.balanceOf(safe);

        _serviceQueue(requestId, shares);

        // The queue entry is gone, the assets never moved, and the shares are still on the manager.
        (address owner, uint256 queued) = wm.requests(requestId);
        assertEq(owner, address(0), "queue entry survived manual servicing");
        assertEq(queued, 0, "queue entry still reports shares");
        assertEq(usdc.balanceOf(safe), safeAssetsBefore, "manual servicing moved assets");
        assertEq(pool.balanceOf(safe), 0, "shares came back to the Safe");
        assertEq(wm.lockedShares(safe), shares, "manual bucket does not hold the shares");
        assertEq(manager.manualShares(), shares, "manager cannot see the manual bucket");
        assertEq(manager.escrowedShares(), 0, "escrow term should be empty after servicing");

        // This is the assertion H1 is about: the position is still valued.
        assertApproxEqAbs(manager.previewNav(), navBefore, NAV_TOLERANCE, "NAV cratered into the manual bucket");
        (,,, uint256 manual) = manager.navComponents();
        assertEq(manual, pool.convertToExitAssets(shares), "manual term does not value the bucket");

        // --- and the bucket is drainable -----------------------------------------------------------------
        vm.prank(OPERATOR);
        uint256 assetsReceived = manager.redeemManual(shares);

        assertGt(assetsReceived, 0, "redeemManual returned nothing");
        assertEq(usdc.balanceOf(safe), safeAssetsBefore + assetsReceived, "assets did not land on the Safe");
        assertEq(wm.lockedShares(safe), 0, "manual bucket not drained");
        assertEq(manager.manualShares(), 0, "manager still sees a manual balance");
        assertApproxEqAbs(manager.previewNav(), navBefore, NAV_TOLERANCE, "NAV moved across redeemManual");
    }

    /* ------------------------------------------------------------ HELPERS ---------------------------------------- */

    /// @dev Enable the manager as a module on the modifier and authorise the targets its calls reach. Executed
    ///      as the Safe, which is the modifier's owner and avatar.
    function _authoriseManagerOnModifier() internal {
        bytes32[] memory roleKeys = new bytes32[](1);
        bool[] memory memberOf = new bool[](1);
        roleKeys[0] = ROLE_KEY;
        memberOf[0] = true;

        IZodiacRolesAdmin roles = IZodiacRolesAdmin(rolesModifier);

        vm.startPrank(safe);
        roles.enableModule(address(manager));
        roles.assignRoles(address(manager), roleKeys, memberOf);
        // `ExecutionOptions.None`: plain calls, no value and no delegatecall — the only thing the manager
        // issues. Target-level rather than parameter-level because the policy is not the subject here; the
        // zac-generated template is tested under `test/fork/templates/`.
        roles.allowTarget(ROLE_KEY, USDC, 0);
        roles.allowTarget(ROLE_KEY, SYRUP_ROUTER, 0);
        roles.allowTarget(ROLE_KEY, SYRUP_USDC, 0);
        roles.allowTarget(ROLE_KEY, SYRUP_WITHDRAWAL_MANAGER, 0);
        vm.stopPrank();
    }

    /// @dev Add or remove the Safe from Maple's lender allowlist, as Maple's own admin.
    function _setSafeAllowlisted(bool allowed) internal {
        address[] memory lenders = new address[](1);
        bool[] memory booleans = new bool[](1);
        lenders[0] = safe;
        booleans[0] = allowed;

        vm.prank(ppm.admin());
        ppm.setLenderAllowlist(MAPLE_POOL_MANAGER, lenders, booleans);
        assertEq(ppm.lenderAllowlist(MAPLE_POOL_MANAGER, safe), allowed, "allowlist write did not take");
    }

    /// @dev Deploy `assets` of the Safe's USDC into the live pool through the manager.
    function _deployIntoPool(uint256 assets) internal returns (uint256 sharesReceived) {
        vm.prank(OPERATOR);
        sharesReceived = manager.deploy(assets, 1);
    }

    /// @dev Queue a redemption of `shares` through the manager.
    function _requestRedeem(uint256 shares) internal returns (uint256 requestId) {
        vm.prank(OPERATOR);
        requestId = manager.requestRedeem(shares);
    }

    /// @dev Buy the live pool enough idle USDC to redeem everything currently queued plus `ownShares`, so a
    ///      later `_serviceQueue` needs no funding of its own.
    ///
    ///      This has to happen *before* the first NAV snapshot of a test. Dealing USDC into the pool raises
    ///      `totalAssets` and therefore the exit rate — a ~1% revaluation of every share in existence — which
    ///      would otherwise be indistinguishable from the discontinuity these tests are looking for.
    function _prefundQueueLiquidity(uint256 ownShares) internal {
        // `type(uint256).max` sums the whole live queue rather than a prefix of it.
        uint256 queued = _sharesQueuedAheadOf(type(uint256).max);
        uint256 required = (pool.convertToExitAssets(queued + ownShares) * 11) / 10;
        if (usdc.balanceOf(SYRUP_USDC) >= required) {
            return;
        }
        deal(USDC, SYRUP_USDC, required);
    }

    /// @dev Service `sharesToProcess` of `requestId` as the pool delegate. The live queue is global and FIFO,
    ///      so everything ahead of the tracked entry is processed first — exactly what the delegate does
    ///      daily. `processRedemptions` refuses to fill partially (`WM:PR:LOW_LIQUIDITY`), so the liquidity
    ///      must already be there: {_prefundQueueLiquidity} is what puts it there.
    function _serviceQueue(uint256 requestId, uint256 sharesToProcess) internal {
        uint256 ahead = _sharesQueuedAheadOf(requestId);
        assertGe(
            usdc.balanceOf(SYRUP_USDC),
            pool.convertToExitAssets(ahead + sharesToProcess),
            "pool cannot cover the redemption; call _prefundQueueLiquidity first"
        );

        address delegate = poolManager.poolDelegate();

        if (ahead != 0) {
            vm.prank(delegate);
            wmFork.processRedemptions(ahead);
            (uint128 nextRequestId,) = wmFork.queue();
            assertEq(uint256(nextRequestId), requestId, "queue head did not reach the tracked request");
        }

        vm.prank(delegate);
        wmFork.processRedemptions(sharesToProcess);
    }

    /// @dev The shares still queued in front of `requestId`, i.e. what the delegate must clear to reach it.
    function _sharesQueuedAheadOf(uint256 requestId) internal view returns (uint256 total) {
        (uint128 nextRequestId, uint128 lastRequestId) = wmFork.queue();
        for (uint256 id = nextRequestId; id < requestId && id <= lastRequestId; ++id) {
            (, uint256 queued) = wm.requests(id);
            total += queued;
        }
    }
}
