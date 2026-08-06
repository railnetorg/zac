// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {SyrupNavManager, DeploymentParams} from "src/SyrupNavManager.sol";
import {ILagoonValuation} from "src/interfaces/ILagoonValuation.sol";
import {IRoleRegistry} from "src/interfaces/IRoleRegistry.sol";
import {ISyrupRouter} from "src/interfaces/ISyrupRouter.sol";
import {IZodiacRoles} from "src/interfaces/IZodiacRoles.sol";

import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LagoonValuationMock} from "./mocks/LagoonValuationMock.sol";
import {RoleRegistryMock} from "./mocks/RoleRegistryMock.sol";
import {RolesMock} from "./mocks/RolesMock.sol";
import {SafeMock} from "./mocks/SafeMock.sol";
import {SyrupPoolManager} from "./mocks/SyrupPoolManager.sol";
import {SyrupPoolMock} from "./mocks/SyrupPoolMock.sol";
import {SyrupRouterMock} from "./mocks/SyrupRouterMock.sol";
import {SyrupWithdrawalManager} from "./mocks/SyrupWithdrawalManager.sol";

/// @title  SyrupNavManagerTestBase
/// @notice Shared fixture. Stands up the whole wiring: a Maple pool with its manager and queue-based withdrawal
///         manager, a Safe with a Roles modifier enabled as a module, a Lagoon valuation surface, and the
///         manager holding the modifier's role key.
abstract contract SyrupNavManagerTestBase is Test {
    uint256 internal constant RATE_SCALE = 1e18;
    uint256 internal constant BPS_MAX = 10_000;

    // ~3155% APY: loose enough that the pool mock's default 5% yield never trips the band.
    uint256 internal constant GROWTH_PER_SECOND = 1e12;
    uint256 internal constant DROP_BPS = 200; // 2%
    uint256 internal constant PUSH_COOLDOWN = 1 hours;
    uint256 internal constant PERMISSIONLESS_DELAY = 2 days;
    uint256 internal constant MAX_OPEN = 4;

    bytes32 internal constant ROLE_KEY = bytes32("SYRUP_NAV");
    bytes32 internal constant DEPOSIT_DATA = bytes32("0:railnet");

    address internal keeper = makeAddr("keeper");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    ERC20Mock internal asset;
    SyrupPoolManager internal poolManager;
    SyrupPoolMock internal pool;
    SyrupWithdrawalManager internal withdrawalManager;
    SyrupRouterMock internal router;

    SafeMock internal safe;
    RolesMock internal roles;
    LagoonValuationMock internal vault;
    RoleRegistryMock internal accessControl;
    SyrupNavManager internal manager;

    function setUp() public virtual {
        asset = new ERC20Mock("USD Coin", "USDC", 6);

        poolManager = new SyrupPoolManager(address(asset));
        pool = poolManager.spawnPool();
        withdrawalManager = poolManager.spawnWithdrawalManager();
        router = new SyrupRouterMock(address(poolManager));

        safe = new SafeMock();
        roles = new RolesMock(safe);
        vault = new LagoonValuationMock(address(asset), address(safe));
        accessControl = new RoleRegistryMock();

        manager = new SyrupNavManager(_params());

        // The manager acts through the modifier, and the modifier acts through the Safe.
        safe.enableModule(address(roles));
        roles.assignRole(ROLE_KEY, address(manager));

        accessControl.grantRole(manager.NAV_PUSH(), keeper);
        accessControl.grantRole(manager.NAV_DEPLOY(), keeper);
        accessControl.grantRole(manager.NAV_REDEEM(), keeper);
        accessControl.grantRole(manager.NAV_ACKNOWLEDGE(), guardian);

        asset.mint(address(safe), 1_000_000e6);
    }

    function _params() internal view returns (DeploymentParams memory) {
        return DeploymentParams({
            accessControl: IRoleRegistry(address(accessControl)),
            vault: ILagoonValuation(address(vault)),
            roles: IZodiacRoles(address(roles)),
            roleKey: ROLE_KEY,
            syrupRouter: ISyrupRouter(address(router)),
            depositData: DEPOSIT_DATA,
            maxRateGrowthPerSecond: GROWTH_PER_SECOND,
            maxRateDropBps: DROP_BPS,
            pushCooldown: PUSH_COOLDOWN,
            permissionlessPushDelay: PERMISSIONLESS_DELAY,
            maxOpenRequests: MAX_OPEN
        });
    }

    /// @dev Deposits `assets` of the Safe's idle balance into the pool via the manager.
    function _deploy(uint256 assets) internal returns (uint256 sharesReceived) {
        vm.prank(keeper);
        return manager.deploy(assets, 0);
    }

    /// @dev Opens a withdrawal request for `shares` of the Safe's pool position.
    function _request(uint256 shares) internal returns (uint256 requestId) {
        vm.prank(keeper);
        return manager.requestRedeem(shares);
    }

    /// @dev Seeds the band so cooldown/band logic has a reference point, then rolls past the cooldown.
    function _seedPush() internal {
        vm.prank(keeper);
        manager.pushNav();
        skip(PUSH_COOLDOWN + 1);
    }

    /// @dev Gives the pool spendable liquidity so the withdrawal queue can be serviced.
    function _fundPoolLiquidity(uint256 amount) internal {
        asset.mint(address(pool), amount);
    }
}

/// @title Constructor and wiring
contract SyrupNavManagerConstructorTest is SyrupNavManagerTestBase {
    function test_Constructor_SetsImmutables() public view {
        assertEq(address(manager.ACCESS_CONTROL()), address(accessControl), "access control");
        assertEq(address(manager.VAULT()), address(vault), "vault");
        assertEq(address(manager.ROLES()), address(roles), "roles");
        assertEq(manager.ROLE_KEY(), ROLE_KEY, "roleKey");
        assertEq(manager.SAFE(), address(safe), "safe derived from the modifier avatar");
        assertEq(address(manager.SYRUP_ROUTER()), address(router), "router");
        assertEq(address(manager.SYRUP_POOL()), address(pool), "pool derived from the router");
        assertEq(address(manager.ASSET()), address(asset), "asset");
        assertEq(manager.DEPOSIT_DATA(), DEPOSIT_DATA, "depositData");
        assertEq(manager.MAX_OPEN_REQUESTS(), MAX_OPEN, "cap");
        assertEq(address(manager.withdrawalManager()), address(withdrawalManager), "withdrawal manager");
    }

    function test_Constructor_RevertWhen_ModifierAvatarIsNotTheVaultSafe() public {
        vault.setSafe(makeAddr("otherSafe"));
        DeploymentParams memory _p = _params();
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.SafeMismatch.selector, vault.safe(), address(safe)));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_VaultAssetIsNotThePoolAsset() public {
        ERC20Mock _other = new ERC20Mock("Other", "OTH", 18);
        LagoonValuationMock _vault = new LagoonValuationMock(address(_other), address(safe));
        DeploymentParams memory _p = _params();
        _p.vault = ILagoonValuation(address(_vault));
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.AssetMismatch.selector, address(_other), address(asset)));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_DropBpsExceedsOneHundredPercent() public {
        DeploymentParams memory _p = _params();
        _p.maxRateDropBps = BPS_MAX + 1;
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidBps.selector, BPS_MAX + 1));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_GrowthBoundIsZero() public {
        DeploymentParams memory _p = _params();
        _p.maxRateGrowthPerSecond = 0;
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidRateBound.selector, 0));
        new SyrupNavManager(_p);
    }

    /// @dev An unbounded growth rate would overflow {rateBand} on a long interval and brick every push, so it
    ///      is rejected up front rather than discovered in production.
    function test_Constructor_RevertWhen_GrowthBoundWouldOverflowTheBand() public {
        DeploymentParams memory _p = _params();
        _p.maxRateGrowthPerSecond = RATE_SCALE + 1;
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidRateBound.selector, RATE_SCALE + 1));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_CooldownIsZero() public {
        DeploymentParams memory _p = _params();
        _p.pushCooldown = 0;
        vm.expectRevert(SyrupNavManager.InvalidDuration.selector);
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_BackstopOpensBeforeTheCooldownExpires() public {
        DeploymentParams memory _p = _params();
        _p.permissionlessPushDelay = PUSH_COOLDOWN - 1;
        vm.expectRevert(SyrupNavManager.InvalidDuration.selector);
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_RequestCapIsZero() public {
        DeploymentParams memory _p = _params();
        _p.maxOpenRequests = 0;
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidRequestCap.selector, 0));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_RequestCapExceedsTheHardCeiling() public {
        DeploymentParams memory _p = _params();
        uint256 _tooMany = manager.MAX_OPEN_REQUESTS_LIMIT() + 1;
        _p.maxOpenRequests = _tooMany;
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidRequestCap.selector, _tooMany));
        new SyrupNavManager(_p);
    }
}

/// @title Valuation
contract SyrupNavManagerValuationTest is SyrupNavManagerTestBase {
    function test_PreviewNav_GivenOnlyIdleAssets() public view {
        (uint256 _idle, uint256 _held, uint256 _escrowed) = manager.navComponents();
        assertEq(_idle, 1_000_000e6, "idle");
        assertEq(_held, 0, "held");
        assertEq(_escrowed, 0, "escrowed");
        assertEq(manager.previewNav(), 1_000_000e6, "nav");
    }

    function test_PreviewNav_GivenIdleAndDeployedAssets() public {
        _deploy(400_000e6);

        (uint256 _idle, uint256 _held, uint256 _escrowed) = manager.navComponents();
        assertEq(_idle, 600_000e6, "idle");
        assertApproxEqAbs(_held, 400_000e6, 1, "held");
        assertEq(_escrowed, 0, "escrowed");
        assertApproxEqAbs(manager.previewNav(), 1_000_000e6, 1, "nav conserved by the deposit");
    }

    /// @dev The core regression: `requestRedeem` moves pool shares out of the Safe into the withdrawal manager.
    ///      A NAV built only from Safe balances would read a crash here. The escrow term is what keeps it
    ///      continuous, and a discontinuity is exactly what would trip Lagoon's guardrails and deadlock the
    ///      vault mid-exit.
    function test_PreviewNav_IsContinuousAcrossARedeemRequest() public {
        _deploy(400_000e6);
        uint256 _navBefore = manager.previewNav();
        uint256 _sharesToQueue = pool.balanceOf(address(safe)) / 2;

        _request(_sharesToQueue);

        (uint256 _idle, uint256 _held, uint256 _escrowed) = manager.navComponents();
        assertEq(pool.balanceOf(address(safe)), _sharesToQueue, "half the shares left the Safe");
        assertGt(_escrowed, 0, "escrow term picks up the shares that left");
        assertApproxEqAbs(_idle + _held + _escrowed, _navBefore, 2, "NAV continuous across the request");
    }

    function test_PreviewNav_IsContinuousAcrossAPartialFill() public {
        _deploy(400_000e6);
        uint256 _shares = pool.balanceOf(address(safe));
        _request(_shares);

        uint256 _navBefore = manager.previewNav();

        // Only a fraction of the queued shares can be paid out, so the entry shrinks but survives.
        _fundPoolLiquidity(50_000e6);
        withdrawalManager.processRedemptions(_shares / 4);

        (uint256 _idle, uint256 _held, uint256 _escrowed) = manager.navComponents();
        assertGt(_idle, 600_000e6, "proceeds landed as idle assets");
        assertGt(_escrowed, 0, "the remainder is still queued");
        assertGe(_idle + _held + _escrowed, _navBefore, "NAV does not drop across a partial fill");
    }

    function test_PreviewNav_IsContinuousAcrossFullService() public {
        _deploy(100_000e6);
        uint256 _shares = pool.balanceOf(address(safe));
        _request(_shares);

        uint256 _navBefore = manager.previewNav();

        _fundPoolLiquidity(200_000e6);
        withdrawalManager.processRedemptions(_shares);

        (uint256 _idle, uint256 _held, uint256 _escrowed) = manager.navComponents();
        assertEq(_escrowed, 0, "nothing left queued");
        assertEq(_held, 0, "nothing left held");
        assertGe(_idle, _navBefore, "NAV does not drop across full service");
    }

    /// @dev Valuation must price through `convertToExitAssets`, which applies the pool's unrealized-loss
    ///      haircut, rather than the optimistic `convertToAssets`.
    function test_PreviewNav_ReflectsUnrealizedLosses() public {
        _deploy(400_000e6);
        uint256 _navBefore = manager.previewNav();

        pool.setUnrealizedLossesPercentage(1000); // 10%

        uint256 _navAfter = manager.previewNav();
        assertLt(_navAfter, _navBefore, "unrealized losses reduce the NAV");
    }

    function test_ExchangeRate_IsParBeforeAnyDeposit() public view {
        assertEq(manager.exchangeRate(), RATE_SCALE, "empty pool prices at par");
    }

    function test_EscrowedShares_IsZeroWhenNothingIsQueued() public {
        _deploy(100_000e6);
        assertEq(manager.escrowedShares(), 0, "nothing queued yet");
        assertEq(manager.openRequests().length, 0, "no open requests");
    }
}

/// @title pushNav
contract SyrupNavManagerPushTest is SyrupNavManagerTestBase {
    function test_PushNav_ProposesToTheVault() public {
        _deploy(400_000e6);
        uint256 _expected = manager.previewNav();

        vm.prank(keeper);
        uint256 _nav = manager.pushNav();

        assertEq(_nav, _expected, "returned nav");
        assertEq(vault.newTotalAssets(), _expected, "vault received the proposal");
        assertEq(vault.proposalCount(), 1, "one proposal");

        (uint256 _lastNav, uint256 _rate, uint256 _pushedAt) = manager.lastPush();
        assertEq(_lastNav, _expected, "lastNav");
        assertEq(_rate, manager.exchangeRate(), "lastRate");
        assertEq(_pushedAt, block.timestamp, "pushedAt");
    }

    function test_PushNav_EmitsComponents() public {
        _deploy(400_000e6);
        (uint256 _idle, uint256 _held, uint256 _escrowed) = manager.navComponents();

        vm.expectEmit(true, true, true, true, address(manager));
        emit SyrupNavManager.NavPushed(_idle + _held + _escrowed, manager.exchangeRate(), _idle, _held, _escrowed);

        vm.prank(keeper);
        manager.pushNav();
    }

    function test_PushNav_RevertWhen_CalledInsideTheCooldown() public {
        vm.prank(keeper);
        manager.pushNav();

        uint256 _nextPushAt = block.timestamp + PUSH_COOLDOWN;
        skip(PUSH_COOLDOWN - 1);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.PushCooldown.selector, _nextPushAt));
        manager.pushNav();
    }

    /// @dev The first push has no staleness to measure, so it is keeper-only: a stranger cannot seed the band.
    function test_PushNav_RevertWhen_StrangerSeedsTheBand() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.PushNotPermissionless.selector, type(uint256).max));
        manager.pushNav();
    }

    /// @dev Not permissionless outright: Lagoon's `settle` must be handed a value matching the live proposal,
    ///      so an unrestricted push would let anyone grief settlement by overwriting it.
    function test_PushNav_RevertWhen_StrangerPushesBeforeTheBackstopOpens() public {
        vm.prank(keeper);
        manager.pushNav();
        uint256 _permissionlessAt = block.timestamp + PERMISSIONLESS_DELAY;

        skip(PUSH_COOLDOWN + 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.PushNotPermissionless.selector, _permissionlessAt));
        manager.pushNav();
    }

    /// @dev The liveness backstop: a dead keeper must not be able to freeze the vault indefinitely.
    function test_PushNav_GivenStaleValuation_AnyoneMayPush() public {
        vm.prank(keeper);
        manager.pushNav();

        skip(PERMISSIONLESS_DELAY + 1);

        vm.prank(stranger);
        manager.pushNav();

        assertEq(vault.proposalCount(), 2, "the stranger's push landed");
    }

    function test_PushNav_RevertWhen_RateDropsBelowTheBand() public {
        _deploy(400_000e6);
        _seedPush();

        // A 10% haircut is far outside the 2% automatic drop tolerance.
        pool.setUnrealizedLossesPercentage(1000);

        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        uint256 _rate = manager.exchangeRate();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RateOutOfBand.selector, _rate, _minRate, _maxRate));
        manager.pushNav();
    }

    function test_PushNav_GivenSmallLossWithinTolerance_Succeeds() public {
        _deploy(400_000e6);
        _seedPush();

        pool.setUnrealizedLossesPercentage(50); // 0.5%, inside the 2% tolerance

        vm.prank(keeper);
        manager.pushNav();
        assertEq(vault.proposalCount(), 2, "in-band loss prices automatically");
    }

    /// @dev A genuine credit event is larger than the automatic tolerance by design. The guardian states the
    ///      band it accepts, and the next push consumes it.
    function test_PushNav_GivenGuardianAcknowledgement_AcceptsOutOfBandRate() public {
        _deploy(400_000e6);
        _seedPush();
        pool.setUnrealizedLossesPercentage(1000);

        uint256 _rate = manager.exchangeRate();
        vm.prank(guardian);
        manager.acknowledgeRate(_rate, _rate, block.timestamp + 1 hours);

        vm.prank(keeper);
        manager.pushNav();

        assertEq(vault.proposalCount(), 2, "acknowledged rate priced");
        assertEq(manager.acknowledgement().expiresAt, 0, "acknowledgement consumed");
    }

    function test_PushNav_GivenAcknowledgementConsumed_SecondOutOfBandPushReverts() public {
        _deploy(400_000e6);
        _seedPush();
        pool.setUnrealizedLossesPercentage(1000);

        uint256 _rate = manager.exchangeRate();
        vm.prank(guardian);
        manager.acknowledgeRate(_rate, _rate, block.timestamp + 10 days);

        vm.prank(keeper);
        manager.pushNav();
        skip(PUSH_COOLDOWN + 1);

        // Another large step down, with no fresh acknowledgement.
        pool.setUnrealizedLossesPercentage(3000);

        vm.prank(keeper);
        vm.expectRevert();
        manager.pushNav();
    }

    function test_PushNav_RevertWhen_AcknowledgementDoesNotCoverTheRate() public {
        _deploy(400_000e6);
        _seedPush();
        pool.setUnrealizedLossesPercentage(1000);

        // Acknowledges a band the measured rate sits below.
        uint256 _rate = manager.exchangeRate();
        vm.prank(guardian);
        manager.acknowledgeRate(_rate + 2, _rate + 3, block.timestamp + 1 hours);

        vm.prank(keeper);
        vm.expectRevert();
        manager.pushNav();
    }

    function test_PushNav_RevertWhen_AcknowledgementHasExpired() public {
        _deploy(400_000e6);
        _seedPush();
        pool.setUnrealizedLossesPercentage(1000);

        uint256 _rate = manager.exchangeRate();
        vm.prank(guardian);
        manager.acknowledgeRate(_rate, _rate, block.timestamp + 10);

        skip(11);

        vm.prank(keeper);
        vm.expectRevert();
        manager.pushNav();
    }

    /// @dev The vault rejecting a proposal is how Lagoon's price-per-share guardrails present. The manager
    ///      must not record the push as accepted, or the band would advance on a value nothing settled at.
    function test_PushNav_RevertWhen_VaultRejectsTheProposal() public {
        vault.setRejectProposals(true);

        vm.prank(keeper);
        vm.expectRevert();
        manager.pushNav();

        (,, uint256 _pushedAt) = manager.lastPush();
        assertEq(_pushedAt, 0, "no push recorded");
    }

    function test_AcknowledgeRate_RevertWhen_CallerIsNotGuardian() public {
        // Read the role before pranking: an external view inside the expectRevert argument would consume it.
        bytes32 _role = manager.NAV_ACKNOWLEDGE();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), keeper));
        manager.acknowledgeRate(1, 2, block.timestamp + 1);
    }

    function test_AcknowledgeRate_RevertWhen_BandIsInverted() public {
        vm.prank(guardian);
        vm.expectRevert(SyrupNavManager.InvalidAcknowledgement.selector);
        manager.acknowledgeRate(2, 1, block.timestamp + 1);
    }

    function test_AcknowledgeRate_RevertWhen_AlreadyExpired() public {
        vm.prank(guardian);
        vm.expectRevert(SyrupNavManager.InvalidAcknowledgement.selector);
        manager.acknowledgeRate(1, 2, block.timestamp);
    }

    function test_RevokeAcknowledgement_ClearsIt() public {
        vm.prank(guardian);
        manager.acknowledgeRate(1, 2, block.timestamp + 1 hours);
        assertGt(manager.acknowledgement().expiresAt, 0, "set");

        vm.prank(guardian);
        manager.revokeAcknowledgement();
        assertEq(manager.acknowledgement().expiresAt, 0, "cleared");
    }

    function test_RateBand_IsUnboundedBeforeTheFirstPush() public view {
        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        assertEq(_minRate, 0, "no floor yet");
        assertEq(_maxRate, type(uint256).max, "no ceiling yet");
    }

    function test_RateBand_WidensWithElapsedTime() public {
        _seedPush();
        (, uint256 _maxBefore) = manager.rateBand();
        skip(30 days);
        (, uint256 _maxAfter) = manager.rateBand();
        assertGt(_maxAfter, _maxBefore, "growth ceiling scales with elapsed time");
    }
}

/// @title deploy
contract SyrupNavManagerDeployTest is SyrupNavManagerTestBase {
    function test_Deploy_MintsPoolSharesToTheSafe() public {
        vm.expectEmit(true, true, true, false, address(manager));
        emit SyrupNavManager.Deployed(400_000e6, 0);

        uint256 _shares = _deploy(400_000e6);

        assertGt(_shares, 0, "shares received");
        assertEq(pool.balanceOf(address(safe)), _shares, "shares landed in the Safe, not the manager");
        assertEq(asset.balanceOf(address(safe)), 600_000e6, "idle reduced");
    }

    /// @dev No standing approval to the router may survive the call.
    function test_Deploy_LeavesNoRouterAllowance() public {
        _deploy(400_000e6);
        assertEq(asset.allowance(address(safe), address(router)), 0, "allowance zeroed");
    }

    function test_Deploy_RevertWhen_AmountIsZero() public {
        vm.prank(keeper);
        vm.expectRevert(SyrupNavManager.ZeroAmount.selector);
        manager.deploy(0, 0);
    }

    function test_Deploy_RevertWhen_SafeHoldsTooLittle() public {
        uint256 _tooMuch = 1_000_000e6 + 1;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InsufficientAssets.selector, _tooMuch, 1_000_000e6));
        manager.deploy(_tooMuch, 0);
    }

    /// @dev Surfaced as a distinct error because the router reports a capped pool and an un-allowlisted Safe
    ///      identically, and the operator needs to tell those apart.
    function test_Deploy_RevertWhen_PoolIsAtItsDepositCap() public {
        pool.setMaxDeposit(1_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.DepositExceedsPoolLimit.selector, 400_000e6, 1_000e6));
        manager.deploy(400_000e6, 0);
    }

    function test_Deploy_RevertWhen_SharesReceivedBelowFloor() public {
        vm.prank(keeper);
        vm.expectRevert();
        manager.deploy(400_000e6, 500_000e6);
    }

    function test_Deploy_RevertWhen_CallerLacksTheRole() public {
        bytes32 _role = manager.NAV_DEPLOY();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), stranger));
        manager.deploy(1e6, 0);
    }

    /// @dev A policy rejection at the modifier must abort the whole operation, not leave the manager's
    ///      accounting ahead of the Safe's state.
    function test_Deploy_RevertWhen_PolicyBlocksTheRouter() public {
        roles.setBlockedTarget(address(router), true);
        vm.prank(keeper);
        vm.expectRevert();
        manager.deploy(400_000e6, 0);
        assertEq(pool.balanceOf(address(safe)), 0, "nothing deployed");
    }

    /// @dev The real modifier reverts on an inner failure, so this guard is defence in depth. It is only
    ///      reachable if the modifier ever reports `false` instead, which the mock forces.
    function test_Deploy_RevertWhen_ModifierReportsFailure() public {
        roles.setForceFailure(true);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.SafeExecutionFailed.selector, address(asset)));
        manager.deploy(400_000e6, 0);
    }
}

/// @title requestRedeem and the open-request set
contract SyrupNavManagerRequestTest is SyrupNavManagerTestBase {
    function setUp() public override {
        super.setUp();
        _deploy(400_000e6);
    }

    function test_RequestRedeem_RecordsTheQueueEntry() public {
        uint256 _shares = pool.balanceOf(address(safe)) / 4;

        uint256 _requestId = _request(_shares);

        assertGt(_requestId, 0, "queue entry created");
        assertEq(manager.openRequests().length, 1, "one open request");
        assertEq(manager.openRequests()[0], _requestId, "id recorded");
        assertEq(manager.escrowedShares(), _shares, "escrow reflects the queued shares");
        assertEq(manager.cancellableRequest(), _requestId, "cancellable");
    }

    /// @dev The point of the design: several exits outstanding at once, no serialisation. The escrow term is a
    ///      sum over the recorded ids, so order is irrelevant and `requestIds` is never consulted again.
    function test_RequestRedeem_SupportsConcurrentRequests() public {
        uint256 _quarter = pool.balanceOf(address(safe)) / 4;

        uint256 _id1 = _request(_quarter);
        uint256 _id2 = _request(_quarter);
        uint256 _id3 = _request(_quarter);

        assertTrue(_id1 != _id2 && _id2 != _id3, "distinct ids");
        assertEq(manager.openRequests().length, 3, "three concurrent requests");
        assertEq(manager.escrowedShares(), _quarter * 3, "escrow sums every open entry");
        assertEq(pool.balanceOf(address(safe)), _quarter, "only the unqueued quarter remains in the Safe");
    }

    function test_RequestRedeem_NavIsUnchangedByHowManyRequestsAnExitIsSplitAcross() public {
        uint256 _half = pool.balanceOf(address(safe)) / 2;
        uint256 _navBefore = manager.previewNav();

        _request(_half / 2);
        _request(_half / 2);

        assertApproxEqAbs(manager.previewNav(), _navBefore, 2, "splitting an exit does not move the NAV");
    }

    function test_RequestRedeem_RevertWhen_CapIsExhausted() public {
        uint256 _slice = pool.balanceOf(address(safe)) / (MAX_OPEN + 1);
        for (uint256 _i = 0; _i < MAX_OPEN; ++_i) {
            _request(_slice);
        }

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.TooManyOpenRequests.selector, MAX_OPEN));
        manager.requestRedeem(_slice);
    }

    /// @dev Maple's public pools run an instant-liquidity buffer, so a request can be serviced in full inside
    ///      the creating transaction, leaving no queue entry. Treating that as a failure would revert a
    ///      successful withdrawal.
    function test_RequestRedeem_GivenImmediateService_ReportsNoQueueEntry() public {
        _fundPoolLiquidity(500_000e6);
        withdrawalManager.setAutoProcess(true);

        uint256 _shares = pool.balanceOf(address(safe)) / 4;
        uint256 _assetsBefore = asset.balanceOf(address(safe));

        vm.expectEmit(true, true, true, false, address(manager));
        emit SyrupNavManager.RedeemServicedImmediately(_shares, 0);

        uint256 _requestId = _request(_shares);

        assertEq(_requestId, 0, "no queue entry survived");
        assertEq(manager.openRequests().length, 0, "nothing tracked");
        assertGt(asset.balanceOf(address(safe)), _assetsBefore, "proceeds landed in the Safe");
    }

    function test_RequestRedeem_RevertWhen_SafeHoldsTooFewShares() public {
        uint256 _held = pool.balanceOf(address(safe));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InsufficientPoolShares.selector, _held + 1, _held));
        manager.requestRedeem(_held + 1);
    }

    function test_RequestRedeem_RevertWhen_SharesAreZero() public {
        vm.prank(keeper);
        vm.expectRevert(SyrupNavManager.ZeroAmount.selector);
        manager.requestRedeem(0);
    }

    function test_RequestRedeem_RevertWhen_CallerLacksTheRole() public {
        bytes32 _role = manager.NAV_REDEEM();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), stranger));
        manager.requestRedeem(1);
    }

    /// @dev A partially serviced entry stays open with fewer shares. Reading remaining shares from the queue
    ///      rather than caching them is what makes this correct.
    function test_RequestRedeem_GivenPartialFill_EntryStaysOpenWithFewerShares() public {
        uint256 _shares = pool.balanceOf(address(safe));
        uint256 _requestId = _request(_shares);

        _fundPoolLiquidity(50_000e6);
        withdrawalManager.processRedemptions(_shares / 8);

        (address _owner, uint256 _queued) = withdrawalManager.requests(_requestId);
        assertEq(_owner, address(safe), "still the Safe's entry");
        assertGt(_queued, 0, "partially filled, still queued");
        assertLt(_queued, _shares, "queued amount shrank");
        assertEq(manager.escrowedShares(), _queued, "escrow tracks the remainder");
        assertEq(manager.openRequests().length, 1, "still tracked");
    }
}

/// @title Pruning
contract SyrupNavManagerPruneTest is SyrupNavManagerTestBase {
    function setUp() public override {
        super.setUp();
        _deploy(400_000e6);
    }

    function test_PruneRequests_DropsServicedEntriesAndKeepsTheRest() public {
        uint256 _quarter = pool.balanceOf(address(safe)) / 4;
        uint256 _id1 = _request(_quarter);
        uint256 _id2 = _request(_quarter);

        // Enough liquidity to fully service the first entry only (FIFO).
        _fundPoolLiquidity(500_000e6);
        withdrawalManager.processRedemptions(_quarter);

        vm.expectEmit(true, false, false, false, address(manager));
        emit SyrupNavManager.RequestCleared(_id1);
        manager.pruneRequests();

        uint256[] memory _open = manager.openRequests();
        assertEq(_open.length, 1, "one entry left");
        assertEq(_open[0], _id2, "the unserviced entry survived");
    }

    function test_PruneRequests_IsPermissionless() public {
        uint256 _shares = pool.balanceOf(address(safe)) / 4;
        _request(_shares);

        _fundPoolLiquidity(500_000e6);
        withdrawalManager.processRedemptions(_shares);

        vm.prank(stranger);
        manager.pruneRequests();

        assertEq(manager.openRequests().length, 0, "a stranger can unwedge the set");
    }

    /// @dev Serviced entries must not hold slots under the cap while the keeper is down.
    function test_PruneRequests_FreesCapacityUnderTheCap() public {
        uint256 _slice = pool.balanceOf(address(safe)) / (MAX_OPEN + 1);
        for (uint256 _i = 0; _i < MAX_OPEN; ++_i) {
            _request(_slice);
        }

        _fundPoolLiquidity(500_000e6);
        withdrawalManager.processRedemptions(_slice);

        // requestRedeem prunes first, so the freed slot is immediately usable.
        uint256 _id = _request(_slice);
        assertGt(_id, 0, "a serviced entry freed a slot");
    }

    function test_PruneRequests_IsANoOpWhenNothingIsOpen() public {
        manager.pruneRequests();
        assertEq(manager.openRequests().length, 0, "still empty");
    }
}

/// @title cancelRedeem
contract SyrupNavManagerCancelTest is SyrupNavManagerTestBase {
    function setUp() public override {
        super.setUp();
        _deploy(400_000e6);
    }

    function test_CancelRedeem_ReturnsSharesToTheSafe() public {
        uint256 _shares = pool.balanceOf(address(safe)) / 4;
        uint256 _requestId = _request(_shares);
        uint256 _heldBefore = pool.balanceOf(address(safe));

        vm.expectEmit(true, true, true, true, address(manager));
        emit SyrupNavManager.RedeemCancelled(_requestId, _shares);

        vm.prank(keeper);
        uint256 _returned = manager.cancelRedeem(_requestId);

        assertEq(_returned, _shares, "all queued shares returned");
        assertEq(pool.balanceOf(address(safe)), _heldBefore + _shares, "shares back in the Safe");
        assertEq(manager.openRequests().length, 0, "entry dropped");
        assertEq(manager.escrowedShares(), 0, "escrow cleared");
    }

    /// @dev Maple resolves a removal through `requestIds(owner)`, so only the latest entry is cancellable.
    ///      Earlier ones must wait for the queue, and asking for one is an explicit error rather than a
    ///      silent cancellation of a different request.
    function test_CancelRedeem_RevertWhen_RequestIsNotTheLatest() public {
        uint256 _quarter = pool.balanceOf(address(safe)) / 4;
        uint256 _id1 = _request(_quarter);
        uint256 _id2 = _request(_quarter);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RequestNotCancellable.selector, _id1, _id2));
        manager.cancelRedeem(_id1);
    }

    function test_CancelRedeem_GivenConcurrentRequests_CancelsTheLatest() public {
        uint256 _quarter = pool.balanceOf(address(safe)) / 4;
        uint256 _id1 = _request(_quarter);
        uint256 _id2 = _request(_quarter);

        vm.prank(keeper);
        manager.cancelRedeem(_id2);

        uint256[] memory _open = manager.openRequests();
        assertEq(_open.length, 1, "one entry left");
        assertEq(_open[0], _id1, "the earlier entry is untouched");
        assertEq(manager.escrowedShares(), _quarter, "escrow reflects the survivor only");
    }

    function test_CancelRedeem_RevertWhen_RequestIsNotTracked() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.UnknownRequest.selector, uint256(999)));
        manager.cancelRedeem(999);
    }

    function test_CancelRedeem_RevertWhen_CallerLacksTheRole() public {
        uint256 _shares = pool.balanceOf(address(safe)) / 4;
        uint256 _requestId = _request(_shares);

        bytes32 _role = manager.NAV_REDEEM();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), stranger));
        manager.cancelRedeem(_requestId);
    }

    function test_CancelRedeem_NavIsContinuousAcrossACancellation() public {
        uint256 _shares = pool.balanceOf(address(safe)) / 4;
        uint256 _requestId = _request(_shares);
        uint256 _navBefore = manager.previewNav();

        vm.prank(keeper);
        manager.cancelRedeem(_requestId);

        assertApproxEqAbs(manager.previewNav(), _navBefore, 2, "cancelling does not move the NAV");
    }
}
