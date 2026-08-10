// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {Acknowledgement, SyrupNavManager, DeploymentParams} from "src/SyrupNavManager.sol";
import {ILagoonValuation} from "src/interfaces/ILagoonValuation.sol";
import {IRoleRegistry} from "src/interfaces/IRoleRegistry.sol";
import {ISyrupRouter} from "src/interfaces/ISyrupRouter.sol";
import {IZodiacRoles} from "src/interfaces/IZodiacRoles.sol";

import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {LagoonValuationMock} from "./mocks/LagoonValuationMock.sol";
import {PoolPermissionManagerMock} from "./mocks/PoolPermissionManagerMock.sol";
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
    // The pool mock starts empty, so one share converts to one asset and the deployment-time rate is par.
    uint256 internal constant INITIAL_RATE = 1e18;
    // Wide enough that the fixture's 5% APY accrual between deployment and the first push never trips it.
    uint256 internal constant INITIAL_RATE_TOLERANCE_BPS = 500; // 5%

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

        // The pool and the withdrawal manager are deployed here and wired into the manager rather than spawned
        // by it: a factory would embed their initcode in the manager's bytecode and push it past EIP-170.
        poolManager = new SyrupPoolManager(address(asset));
        pool = new SyrupPoolMock(address(asset), address(poolManager));
        poolManager.setPool(address(pool));
        withdrawalManager = new SyrupWithdrawalManager(address(pool), address(poolManager));
        poolManager.setWithdrawalManager(address(withdrawalManager));
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
            initialRate: INITIAL_RATE,
            initialRateToleranceBps: INITIAL_RATE_TOLERANCE_BPS,
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

    /// @dev L6. `InvalidContract` guards the most realistic deployment failure there is -- a script with an
    ///      address left unset -- and has six raise sites with nothing asserting any of them. Each case checks
    ///      the argument as well as the selector, so a later reordering of the constructor's checks cannot
    ///      quietly point the error at a different parameter.
    function test_Constructor_RevertWhen_AccessControlIsNotAContract() public {
        DeploymentParams memory _p = _params();
        _p.accessControl = IRoleRegistry(address(0));
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidContract.selector, address(0)));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_VaultIsNotAContract() public {
        DeploymentParams memory _p = _params();
        _p.vault = ILagoonValuation(address(0));
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidContract.selector, address(0)));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_RolesModifierIsNotAContract() public {
        DeploymentParams memory _p = _params();
        _p.roles = IZodiacRoles(address(0));
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidContract.selector, address(0)));
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_RouterIsNotAContract() public {
        DeploymentParams memory _p = _params();
        _p.syrupRouter = ISyrupRouter(address(0));
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidContract.selector, address(0)));
        new SyrupNavManager(_p);
    }

    /// @dev The other half of the same guard, and the likelier typo: a wrong address is far more often an EOA
    ///      than the zero address. Without the code-length check the constructor would fail on an opaque
    ///      decoding revert from `avatar()` instead of naming the offending argument.
    function test_Constructor_RevertWhen_RouterIsAnAddressWithoutCode() public {
        address _eoa = makeAddr("eoaRouter");
        DeploymentParams memory _p = _params();
        _p.syrupRouter = ISyrupRouter(_eoa);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidContract.selector, _eoa));
        new SyrupNavManager(_p);
    }

    /// @dev A modifier with no avatar drives no Safe, so there is nothing to value. Reported as
    ///      `InvalidContract(0)` rather than `SafeMismatch`, because the avatar is the authority on which Safe
    ///      the modifier drives and it has just answered "none".
    function test_Constructor_RevertWhen_ModifierAvatarIsZero() public {
        DeploymentParams memory _p = _params();
        vm.mockCall(address(roles), abi.encodeCall(IZodiacRoles.avatar, ()), abi.encode(address(0)));
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidContract.selector, address(0)));
        new SyrupNavManager(_p);
    }

    /// @dev L6/L1. The rate anchor is the only reference point in the valuation that does not come from the
    ///      pool, so a zero anchor would collapse the first band instead of bounding it.
    function test_Constructor_RevertWhen_InitialRateIsZero() public {
        DeploymentParams memory _p = _params();
        _p.initialRate = 0;
        vm.expectRevert(SyrupNavManager.InvalidInitialRate.selector);
        new SyrupNavManager(_p);
    }

    function test_Constructor_RevertWhen_InitialRateToleranceExceedsOneHundredPercent() public {
        DeploymentParams memory _p = _params();
        _p.initialRateToleranceBps = BPS_MAX + 1;
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.InvalidBps.selector, BPS_MAX + 1));
        new SyrupNavManager(_p);
    }
}

/// @title Valuation
contract SyrupNavManagerValuationTest is SyrupNavManagerTestBase {
    function test_PreviewNav_GivenOnlyIdleAssets() public view {
        (uint256 _idle, uint256 _held, uint256 _escrowed, uint256 _manual) = manager.navComponents();
        assertEq(_idle, 1_000_000e6, "idle");
        assertEq(_held, 0, "held");
        assertEq(_escrowed, 0, "escrowed");
        assertEq(_manual, 0, "manual");
        assertEq(manager.previewNav(), 1_000_000e6, "nav");
    }

    function test_PreviewNav_GivenIdleAndDeployedAssets() public {
        _deploy(400_000e6);

        (uint256 _idle, uint256 _held, uint256 _escrowed, uint256 _manual) = manager.navComponents();
        assertEq(_idle, 600_000e6, "idle");
        assertApproxEqAbs(_held, 400_000e6, 1, "held");
        assertEq(_escrowed, 0, "escrowed");
        assertEq(_manual, 0, "manual");
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

        (uint256 _idle, uint256 _held, uint256 _escrowed, uint256 _manual) = manager.navComponents();
        assertEq(pool.balanceOf(address(safe)), _sharesToQueue, "half the shares left the Safe");
        assertGt(_escrowed, 0, "escrow term picks up the shares that left");
        assertEq(_manual, 0, "nothing in the manual bucket");
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

        (uint256 _idle, uint256 _held, uint256 _escrowed, uint256 _manual) = manager.navComponents();
        assertGt(_idle, 600_000e6, "proceeds landed as idle assets");
        assertGt(_escrowed, 0, "the remainder is still queued");
        assertEq(_manual, 0, "nothing in the manual bucket");
        assertGe(_idle + _held + _escrowed, _navBefore, "NAV does not drop across a partial fill");
    }

    function test_PreviewNav_IsContinuousAcrossFullService() public {
        _deploy(100_000e6);
        uint256 _shares = pool.balanceOf(address(safe));
        _request(_shares);

        uint256 _navBefore = manager.previewNav();

        _fundPoolLiquidity(200_000e6);
        withdrawalManager.processRedemptions(_shares);

        (uint256 _idle, uint256 _held, uint256 _escrowed, uint256 _manual) = manager.navComponents();
        assertEq(_escrowed, 0, "nothing left queued");
        assertEq(_held, 0, "nothing left held");
        assertEq(_manual, 0, "nothing in the manual bucket");
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
        (uint256 _idle, uint256 _held, uint256 _escrowed, uint256 _manual) = manager.navComponents();

        vm.expectEmit(true, true, true, true, address(manager));
        emit SyrupNavManager.NavPushed(
            _idle + _held + _escrowed + _manual, manager.exchangeRate(), _idle, _held, _escrowed, _manual
        );

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

        // Another large step down, with no fresh acknowledgement. Asserting the selector is the whole point
        // here: the one-shot property of the acknowledgement is a security invariant, and a bare
        // `vm.expectRevert()` would be satisfied just as well by a `PushCooldown`.
        pool.setUnrealizedLossesPercentage(3000);

        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        uint256 _secondRate = manager.exchangeRate();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RateOutOfBand.selector, _secondRate, _minRate, _maxRate));
        manager.pushNav();
    }

    /// @dev And the one-shot property itself, which the test above cannot reach: there the second rate sat
    ///      outside the acknowledged band, so a persistent acknowledgement would have refused the push anyway.
    ///      Here the band is wide enough to cover both moves, so the second push is refused only because the
    ///      first consumed the acknowledgement. That is what stops a one-off credit event from becoming a
    ///      standing exemption.
    function test_PushNav_GivenAcknowledgementConsumed_ARateTheOldBandCoveredIsRefused() public {
        _deploy(400_000e6);
        _seedPush();
        pool.setUnrealizedLossesPercentage(1000);

        uint256 _rate = manager.exchangeRate();
        vm.prank(guardian);
        manager.acknowledgeRate(_rate / 2, (_rate * 3) / 2, block.timestamp + 10 days);

        vm.prank(keeper);
        manager.pushNav();
        skip(PUSH_COOLDOWN + 1);

        pool.setUnrealizedLossesPercentage(3000);

        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        uint256 _secondRate = manager.exchangeRate();
        assertGt(_secondRate, _rate / 2, "the second rate sits inside the band the guardian acknowledged");
        assertLt(_secondRate, _minRate, "and outside the automatic band, so only the acknowledgement could pass it");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RateOutOfBand.selector, _secondRate, _minRate, _maxRate));
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

        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RateOutOfBand.selector, _rate, _minRate, _maxRate));
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

        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        uint256 _rateNow = manager.exchangeRate();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RateOutOfBand.selector, _rateNow, _minRate, _maxRate));
        manager.pushNav();
    }

    /// @dev The vault rejecting a proposal is how Lagoon's price-per-share guardrails present. The manager
    ///      must not record the push as accepted, or the band would advance on a value nothing settled at.
    function test_PushNav_RevertWhen_VaultRejectsTheProposal() public {
        vault.setRejectProposals(true);

        uint256 _proposed = manager.previewNav();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(LagoonValuationMock.GuardRailRejected.selector, _proposed));
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

    /// @dev L1. The band is self-referential once seeded, so the seed is anchored on a deployment-time
    ///      expectation rather than left wide open. Before this fix the unseeded band was
    ///      `(0, type(uint256).max)`, so the first push -- the moment the vault starts trusting this manager --
    ///      set the anchor for every later band to whatever the pool happened to report.
    function test_RateBand_IsAnchoredOnTheInitialRateBeforeTheFirstPush() public view {
        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        uint256 _tolerance = (INITIAL_RATE * INITIAL_RATE_TOLERANCE_BPS) / BPS_MAX;
        assertEq(_minRate, INITIAL_RATE - _tolerance, "floor anchored on the initial rate");
        assertEq(_maxRate, INITIAL_RATE + _tolerance, "ceiling anchored on the initial rate");
        assertLt(_maxRate, type(uint256).max, "the first push is no longer unbounded");
    }

    /// @dev And the anchor is enforced: a pool whose rate sits outside the deployment expectation cannot seed
    ///      the band at all.
    function test_PushNav_RevertWhen_FirstRateIsOutsideTheInitialBand() public {
        _deploy(400_000e6);
        // Lift price-per-share far beyond the 5% tolerance without minting shares.
        pool.addAssets(400_000e6);

        (uint256 _minRate, uint256 _maxRate) = manager.rateBand();
        uint256 _rate = manager.exchangeRate();
        assertGt(_rate, _maxRate, "the rate really is outside the anchored band");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RateOutOfBand.selector, _rate, _minRate, _maxRate));
        manager.pushNav();
    }

    function test_RateBand_WidensWithElapsedTime() public {
        _seedPush();
        (, uint256 _maxBefore) = manager.rateBand();
        skip(30 days);
        (, uint256 _maxAfter) = manager.rateBand();
        assertGt(_maxAfter, _maxBefore, "growth ceiling scales with elapsed time");
    }

    /// @dev M6. The acknowledgement is bounded on BOTH sides precisely so that acknowledging a credit loss is
    ///      not also a licence to revalue upwards without limit. Every other acknowledgement test drives the
    ///      rate down, so the upper half of that bound had nothing exercising it.
    function test_PushNav_GivenGuardianAcknowledgement_AcceptsAnUpwardOutOfBandRate() public {
        _deploy(400_000e6);
        _seedPush();

        // Lifts price-per-share without minting shares: an upward move far beyond the growth ceiling.
        pool.addAssets(200_000e6);

        (, uint256 _maxRate) = manager.rateBand();
        uint256 _rate = manager.exchangeRate();
        assertGt(_rate, _maxRate, "the rate really is above the automatic ceiling");

        vm.prank(guardian);
        manager.acknowledgeRate(_rate, _rate, block.timestamp + 1 hours);

        vm.prank(keeper);
        manager.pushNav();

        assertEq(vault.proposalCount(), 2, "the acknowledged upward rate priced");
        assertEq(manager.acknowledgement().expiresAt, 0, "and the acknowledgement was consumed");
    }

    /// @dev M6. `_checkRateBand` returns before it touches the acknowledgement when the rate is in band, and
    ///      that ordering is load-bearing: a guardian who pre-authorises a band must still hold it when the
    ///      credit event lands, not find it burned by a routine push. A refactor that consumed it
    ///      unconditionally would pass every other test in this suite.
    function test_PushNav_GivenInBandPush_DoesNotConsumeALiveAcknowledgement() public {
        _deploy(400_000e6);
        _seedPush();

        uint256 _rate = manager.exchangeRate();
        uint256 _expiresAt = block.timestamp + 1 days;
        vm.prank(guardian);
        manager.acknowledgeRate(_rate / 2, _rate * 2, _expiresAt);

        vm.prank(keeper);
        manager.pushNav();

        Acknowledgement memory _ack = manager.acknowledgement();
        assertEq(vault.proposalCount(), 2, "the in-band push landed");
        assertEq(_ack.expiresAt, _expiresAt, "the acknowledgement survived the push");
        assertEq(_ack.minRate, _rate / 2, "with its floor intact");
        assertEq(_ack.maxRate, _rate * 2, "and its ceiling intact");
    }

    /// @dev A zero floor is an unbounded downward authorisation, which is the one thing a two-sided
    ///      acknowledgement exists to refuse.
    function test_AcknowledgeRate_RevertWhen_MinRateIsZero() public {
        vm.prank(guardian);
        vm.expectRevert(SyrupNavManager.InvalidAcknowledgement.selector);
        manager.acknowledgeRate(0, 2e18, block.timestamp + 1 hours);
    }

    /// @dev A guardian who mis-states a band must be able to replace it in one call, so the newer
    ///      acknowledgement wins outright rather than being refused as "one already live".
    function test_AcknowledgeRate_OverwritesALiveAcknowledgement() public {
        vm.prank(guardian);
        manager.acknowledgeRate(1e18, 2e18, block.timestamp + 1 hours);

        vm.expectEmit(true, true, true, true, address(manager));
        emit SyrupNavManager.RateAcknowledged(3e18, 4e18, block.timestamp + 2 hours);
        vm.prank(guardian);
        manager.acknowledgeRate(3e18, 4e18, block.timestamp + 2 hours);

        Acknowledgement memory _ack = manager.acknowledgement();
        assertEq(_ack.minRate, 3e18, "floor replaced");
        assertEq(_ack.maxRate, 4e18, "ceiling replaced");
        assertEq(_ack.expiresAt, block.timestamp + 2 hours, "expiry replaced");
    }

    function test_RevokeAcknowledgement_RevertWhen_CallerIsNotGuardian() public {
        bytes32 _role = manager.NAV_ACKNOWLEDGE();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), keeper));
        manager.revokeAcknowledgement();
    }

    /// @dev M6 boundary. `acknowledgeRate` refuses `expiresAt <= block.timestamp` while `_checkRateBand`
    ///      accepts while `expiresAt >= block.timestamp`, so an acknowledgement expiring in this very second is
    ///      still usable. Nothing pinned that edge -- the nearest test skipped a full second past expiry.
    function test_PushNav_GivenAcknowledgementExpiringThisSecond_IsStillUsable() public {
        _deploy(400_000e6);
        _seedPush();
        pool.setUnrealizedLossesPercentage(1000);

        uint256 _rate = manager.exchangeRate();
        uint256 _expiresAt = block.timestamp + 10;
        vm.prank(guardian);
        // A percent either side, so a wei of yield accrual over the skip cannot decide the test.
        manager.acknowledgeRate((_rate * 99) / 100, (_rate * 101) / 100, _expiresAt);

        skip(10);
        assertEq(block.timestamp, _expiresAt, "sitting exactly on the expiry second");

        vm.prank(keeper);
        manager.pushNav();

        assertEq(vault.proposalCount(), 2, "an acknowledgement expiring this second still prices");
    }

    /// @dev The cooldown gate is `>=`, so a push at exactly `lastPushAt + PUSH_COOLDOWN` must be accepted. An
    ///      off-by-one here would cost the keeper a whole interval on every cycle, silently.
    function test_PushNav_GivenExactlyTheCooldownHasElapsed_Succeeds() public {
        vm.prank(keeper);
        manager.pushNav();
        (,, uint256 _pushedAt) = manager.lastPush();

        vm.warp(_pushedAt + PUSH_COOLDOWN);

        vm.prank(keeper);
        manager.pushNav();
        assertEq(vault.proposalCount(), 2, "the push on the cooldown boundary landed");
    }

    /// @dev And the backstop opens on its own boundary second, which is what bounds how long a dead keeper can
    ///      hold the vault stale: `PERMISSIONLESS_PUSH_DELAY` exactly, not one second more.
    function test_PushNav_GivenExactlyTheBackstopDelayHasElapsed_IsPermissionless() public {
        vm.prank(keeper);
        manager.pushNav();
        (,, uint256 _pushedAt) = manager.lastPush();

        vm.warp(_pushedAt + PERMISSIONLESS_DELAY);

        vm.prank(stranger);
        manager.pushNav();
        assertEq(vault.proposalCount(), 2, "a stranger may push on the backstop's boundary second");
    }

    /// @dev The registry grants roles globally or scoped to one contract, and every other test uses the global
    ///      form. A scoped grant is how an operator is authorised for this manager alone, so it has to
    ///      authorise -- otherwise half of the registry's trust model is untested.
    function test_PushNav_GivenScopedRole_AuthorisesTheCaller() public {
        address _scopedKeeper = makeAddr("scopedKeeper");
        accessControl.grantScopedRole(manager.NAV_PUSH(), address(manager), _scopedKeeper);

        vm.prank(_scopedKeeper);
        manager.pushNav();

        assertEq(vault.proposalCount(), 1, "a scope-limited grant is enough to seed the band");
    }

    /// @dev L2. `isTotalAssetsValid` was declared on the vault interface and read by nothing. The keeper needs
    ///      all three facts to decide whether to push, and this is the one call that reports them -- so each
    ///      state it distinguishes is pinned here, including both boundary seconds.
    function test_PushStatus_ReportsCooldownBackstopAndValuationFreshness() public {
        (bool _cooldownElapsed, bool _permissionless, bool _valuationValid) = manager.pushStatus();
        assertTrue(_cooldownElapsed, "no cooldown to wait out before the first push");
        assertFalse(_permissionless, "but the first push is keeper-only");
        assertTrue(_valuationValid, "the vault's valuation starts fresh");

        vm.prank(keeper);
        manager.pushNav();

        (_cooldownElapsed, _permissionless,) = manager.pushStatus();
        assertFalse(_cooldownElapsed, "inside the cooldown");
        assertFalse(_permissionless, "and nowhere near the backstop");

        skip(PUSH_COOLDOWN);
        (_cooldownElapsed, _permissionless,) = manager.pushStatus();
        assertTrue(_cooldownElapsed, "cooldown reports elapsed on its boundary second");
        assertFalse(_permissionless, "while the backstop is still shut");

        skip(PERMISSIONLESS_DELAY - PUSH_COOLDOWN);
        (_cooldownElapsed, _permissionless,) = manager.pushStatus();
        assertTrue(_cooldownElapsed, "still past the cooldown");
        assertTrue(_permissionless, "and the backstop reports open on its boundary second");

        vault.setTotalAssetsValid(false);
        (,, _valuationValid) = manager.pushStatus();
        assertFalse(_valuationValid, "an expired vault valuation is reported as stale");
    }
}

/// @title deploy
contract SyrupNavManagerDeployTest is SyrupNavManagerTestBase {
    function test_Deploy_MintsPoolSharesToTheSafe() public {
        // `Deployed` declares no indexed parameters, so a `checkData = false` expectation asserted nothing but
        // the signature -- the two figures written here were simply discarded.
        uint256 _expectedShares = pool.previewDeposit(400_000e6);
        vm.expectEmit(true, true, true, true, address(manager));
        emit SyrupNavManager.Deployed(400_000e6, _expectedShares);

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

    /// @dev The floor is a liveness assertion rather than a price guard, and the error carries both figures so
    ///      an operator can see how far short the router fell.
    function test_Deploy_RevertWhen_SharesReceivedBelowFloor() public {
        uint256 _expectedShares = pool.previewDeposit(400_000e6);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(SyrupNavManager.InsufficientSharesReceived.selector, _expectedShares, 500_000e6)
        );
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
        vm.expectRevert(abi.encodeWithSelector(RolesMock.TargetBlockedByPolicy.selector, address(router)));
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

    /// @dev L3. `maxDeposit` returns 0 for an un-allowlisted Safe and for a pool at its cap alike, and never
    ///      reverts. The remedies could not be further apart -- Maple's onboarding desk versus waiting for
    ///      capacity -- so the two states must not present as the same error.
    function test_Deploy_RevertWhen_SafeIsNotAllowlisted() public {
        _gateDepositsBehindTheBitmap();

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.NotAllowlisted.selector, address(safe)));
        manager.deploy(400_000e6, 0);
    }

    /// @dev And `lenderAllowlist` short-circuits before any bitmap is read, which is why it -- rather than a
    ///      bitmap bit -- is what the Safe should hold: it survives Maple changing the bitmap later.
    function test_Deploy_GivenAllowlistedSafe_Succeeds() public {
        PoolPermissionManagerMock _ppm = _gateDepositsBehindTheBitmap();
        _ppm.setLenderAllowlist(address(poolManager), address(safe), true);

        uint256 _shares = _deploy(400_000e6);

        assertGt(_shares, 0, "the allowlist entry short-circuits the bitmap the Safe does not hold");
        assertEq(pool.balanceOf(address(safe)), _shares, "and the deposit landed in the Safe");
    }

    /// @dev The other side of the split: with permission granted a zero `maxDeposit` really is a full pool, and
    ///      must still report as one rather than as a permissioning gap.
    function test_Deploy_RevertWhen_AllowlistedPoolIsFull() public {
        PoolPermissionManagerMock _ppm = _gateDepositsBehindTheBitmap();
        _ppm.setLenderAllowlist(address(poolManager), address(safe), true);
        pool.setMaxDeposit(0);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.DepositExceedsPoolLimit.selector, 400_000e6, 0));
        manager.deploy(400_000e6, 0);
    }

    /// @dev The deployment preflight: a keeper reads this before deploying rather than discovering the gap from
    ///      a reverted deposit. Both ways of holding permission -- the bit and the allowlist -- are reported.
    function test_IsDepositAllowlisted_TracksThePermissionManager() public {
        PoolPermissionManagerMock _ppm = _gateDepositsBehindTheBitmap();
        assertFalse(manager.isDepositAllowlisted(), "gated behind a bitmap the Safe does not hold");

        _ppm.setLenderBitmap(address(safe), 16);
        assertTrue(manager.isDepositAllowlisted(), "holding the bit is enough");

        _ppm.setLenderBitmap(address(safe), 0);
        _ppm.setLenderAllowlist(address(poolManager), address(safe), true);
        assertTrue(manager.isDepositAllowlisted(), "and so is the allowlist, with no bits at all");
    }

    /// @dev Configures Maple's permission manager the way syrupUSDC is configured on mainnet: FUNCTION_LEVEL,
    ///      with a non-zero `P:deposit` bitmap the Safe does not hold. Per-test on purpose -- the fixture's
    ///      default of no permission manager models an open pool, which is what every other test wants.
    function _gateDepositsBehindTheBitmap() internal returns (PoolPermissionManagerMock ppm) {
        ppm = new PoolPermissionManagerMock();
        ppm.setPermissionLevel(address(poolManager), 1);
        ppm.setPoolBitmap(address(poolManager), bytes32("P:deposit"), 16);
        poolManager.setPoolPermissionManager(address(ppm));
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

        (uint256[] memory _queuedIds, uint256[] memory _queuedShares) = withdrawalManager.requestsByOwner(address(safe));
        assertEq(_queuedIds.length, 1, "one request on the queue for the Safe");
        assertEq(_queuedIds[0], _requestId, "queue agrees on the id");
        assertEq(_queuedShares[0], _shares, "queue agrees on the shares");
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

    /// @dev The queue manager has no branch that services a request inside the transaction that creates it:
    ///      `addShares` unconditionally appends. So a fresh entry survives even when the pool is fully liquid,
    ///      and the manager always has an id to track. The previous shape of this test asserted an
    ///      immediate-service path that does not exist in Maple.
    function test_RequestRedeem_GivenFullLiquidity_StillQueuesAnEntry() public {
        _fundPoolLiquidity(500_000e6);

        uint256 _shares = pool.balanceOf(address(safe)) / 4;
        uint256 _assetsBefore = asset.balanceOf(address(safe));

        uint256 _requestId = _request(_shares);

        assertGt(_requestId, 0, "a queue entry survives even with liquidity to spare");
        assertEq(manager.openRequests().length, 1, "and it is tracked");
        assertEq(manager.escrowedShares(), _shares, "valued as escrow, not as proceeds");
        assertEq(asset.balanceOf(address(safe)), _assetsBefore, "no assets moved yet");
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

    /// @dev `_prune` walks the set downward with swap-and-pop, and every other test removes at most one entry,
    ///      so the swap itself is never exercised. Servicing all but the newest of a full set removes three in
    ///      one pass: an off-by-one in the loop or a stale length read would surface here as the wrong survivor
    ///      or as a live entry dropped.
    function test_PruneRequests_DropsSeveralEntriesInOnePass() public {
        uint256 _slice = pool.balanceOf(address(safe)) / MAX_OPEN;
        uint256[] memory _ids = new uint256[](MAX_OPEN);
        for (uint256 _i = 0; _i < MAX_OPEN; ++_i) {
            _ids[_i] = _request(_slice);
        }

        // The queue services FIFO by id, so this settles every entry except the newest.
        _fundPoolLiquidity(500_000e6);
        withdrawalManager.processRedemptions(_slice * (MAX_OPEN - 1));

        manager.pruneRequests();

        uint256[] memory _open = manager.openRequests();
        assertEq(_open.length, 1, "every serviced entry dropped in a single pass");
        assertEq(_open[0], _ids[MAX_OPEN - 1], "and the survivor is the one still queued");
        assertEq(manager.escrowedShares(), _slice, "escrow reflects the survivor alone");
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

    /// @dev The H2(b) win. `Pool.removeShares` resolves through the owner's newest queue entry, so it can only
    ///      ever unwind that one and an earlier request has to wait out the queue. `removeSharesById` is exact,
    ///      so the oldest outstanding request is cancellable too -- which is the one most likely to be stuck.
    function test_CancelRedeem_CancelsAnEarlierRequestNotJustTheLatest() public {
        uint256 _quarter = pool.balanceOf(address(safe)) / 4;
        uint256 _id1 = _request(_quarter);
        uint256 _id2 = _request(_quarter);
        uint256 _heldBefore = pool.balanceOf(address(safe));

        vm.prank(keeper);
        uint256 _returned = manager.cancelRedeem(_id1);

        assertEq(_returned, _quarter, "the earlier request was cancelled");
        assertEq(pool.balanceOf(address(safe)), _heldBefore + _quarter, "its shares came back");

        uint256[] memory _open = manager.openRequests();
        assertEq(_open.length, 1, "one entry left");
        assertEq(_open[0], _id2, "and it is the newer one");
    }

    /// @dev Cancellation is exact-by-id, so the caller names the entry and gets that entry, whichever it is.
    function test_CancelRedeem_GivenConcurrentRequests_CancelsExactlyTheNamedEntry() public {
        uint256 _quarter = pool.balanceOf(address(safe)) / 4;
        uint256 _id1 = _request(_quarter);
        uint256 _id2 = _request(_quarter);

        vm.prank(keeper);
        manager.cancelRedeem(_id2);

        uint256[] memory _open = manager.openRequests();
        assertEq(_open.length, 1, "one entry left");
        assertEq(_open[0], _id1, "the other entry is untouched");
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

    /// @dev A scoped grant is the operator's real authorisation, and revoking it has to bite immediately --
    ///      including on a request that operator opened while it still held the role. Authorisation cached
    ///      anywhere would leave an offboarded keeper able to unwind live exits.
    function test_CancelRedeem_RevertWhen_ScopedRoleIsRevokedMidLifecycle() public {
        address _operator = makeAddr("scopedOperator");
        bytes32 _role = manager.NAV_REDEEM();
        accessControl.grantScopedRole(_role, address(manager), _operator);

        uint256 _shares = pool.balanceOf(address(safe)) / 4;
        vm.prank(_operator);
        uint256 _requestId = manager.requestRedeem(_shares);
        assertEq(manager.openRequests().length, 1, "the scoped grant authorised the request");

        accessControl.revokeScopedRole(_role, address(manager), _operator);

        vm.prank(_operator);
        vm.expectRevert(
            abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), _operator)
        );
        manager.cancelRedeem(_requestId);

        assertEq(manager.escrowedShares(), _shares, "and the request stays valued rather than stranded");
    }
}

/// @title  NAV pushes across a redemption lifecycle
/// @notice The contract's entire justification, asserted end to end: Lagoon's price-per-share guardrail keeps
///         accepting the proposal while a redemption moves through Maple's queue.
/// @dev    M1. Every other continuity test asserts on `previewNav()`, which proves the arithmetic but never
///         that the vault would take the value. These push, against a guardrail that rejects as a function of
///         the value rather than unconditionally -- the only shape that can express "this NAV move would trip
///         the real guardrail, that one would not".
contract SyrupNavManagerPushContinuityTest is SyrupNavManagerTestBase {
    /// @dev A realistic price-per-share bound: 1% per proposal. The four-term NAV moves only by pool yield,
    ///      orders of magnitude inside it, while dropping a term moves it by the whole queued position.
    uint256 internal constant GUARDRAIL_BPS = 100;

    function setUp() public override {
        super.setUp();
        vault.setMaxMoveBps(GUARDRAIL_BPS);
        _deploy(400_000e6);
    }

    /// @dev The lifecycle in one test: deploy -> push -> requestRedeem -> push -> partial fill -> push -> full
    ///      service -> push, with the guardrail live the whole way. Nothing in the suite pushed across a
    ///      redemption before, so the property the escrow term exists for had never been demonstrated.
    function test_PushNav_IsAcceptedAcrossAFullRedemptionLifecycle() public {
        uint256 _shares = pool.balanceOf(address(safe));

        uint256 _atDeployment = _pushAndReadProposal(1);

        _request(_shares);
        uint256 _afterRequest = _pushAndReadProposal(2);
        _assertMovedContinuously(_atDeployment, _afterRequest, "the request moved the NAV past the guardrail");

        // A partial fill: a quarter of the queued shares pay out, the rest stay queued.
        _fundPoolLiquidity(500_000e6);
        withdrawalManager.processRedemptions(_shares / 4);
        uint256 _afterPartialFill = _pushAndReadProposal(3);
        assertGt(manager.escrowedShares(), 0, "the remainder is still queued");
        _assertMovedContinuously(_afterRequest, _afterPartialFill, "the partial fill moved the NAV past the guardrail");

        // And the remainder, which is where a NAV missing the escrow term would spike back up.
        withdrawalManager.processRedemptions(_shares);
        assertEq(manager.escrowedShares(), 0, "nothing left queued");
        uint256 _afterFullService = _pushAndReadProposal(4);
        _assertMovedContinuously(_afterPartialFill, _afterFullService, "full service moved the NAV past the guardrail");
    }

    /// @dev The regression guard, and what makes the escrow term load-bearing rather than decorative. With the
    ///      same guardrail configured, the NAV a three-term valuation would have produced right after
    ///      `requestRedeem` -- `idle + held`, with the escrowed shares dropped -- sits far enough from the
    ///      pre-request proposal that the vault refuses it outright, while the real four-term `previewNav()` is
    ///      accepted at the same instant. That refusal is Lagoon's guardrail deadlocking the vault mid-exit,
    ///      with the exchange rate still inside its band so nothing upstream would have blocked the push.
    function test_PushNav_RevertWhen_EscrowTermIsMissing() public {
        vm.prank(keeper);
        uint256 _beforeRequest = manager.pushNav();
        skip(PUSH_COOLDOWN + 1);

        _request(pool.balanceOf(address(safe)));

        (uint256 _idle, uint256 _held, uint256 _escrowed,) = manager.navComponents();
        uint256 _threeTermNav = _idle + _held;
        assertGt(_escrowed, 0, "the escrow term is carrying the whole queued position");
        assertLt(_threeTermNav, _beforeRequest, "so dropping it craters the NAV");

        // The guardrail prices a hypothetical, so it can be asked about a NAV nobody proposed.
        assertFalse(vault.wouldAccept(_threeTermNav), "a three-term NAV would be refused");
        assertTrue(vault.wouldAccept(manager.previewNav()), "while the four-term NAV would not be");

        vm.expectRevert(abi.encodeWithSelector(LagoonValuationMock.GuardRailRejected.selector, _threeTermNav));
        vault.updateNewTotalAssets(_threeTermNav);

        vm.prank(keeper);
        manager.pushNav();
        assertEq(vault.proposalCount(), 2, "the four-term NAV settles where the three-term one could not");
    }

    /// @dev Pushes as the keeper, checks the vault took exactly the proposed value, then rolls past the
    ///      cooldown so the next leg of the lifecycle can push.
    function _pushAndReadProposal(uint256 expectedCount) internal returns (uint256 proposed) {
        vm.prank(keeper);
        proposed = manager.pushNav();
        assertEq(vault.proposalCount(), expectedCount, "the guardrail accepted the push");
        assertEq(vault.newTotalAssets(), proposed, "and recorded exactly the proposed value");
        skip(PUSH_COOLDOWN + 1);
    }

    /// @dev The guardrail's own arithmetic, asserted directly so a failure names the move rather than only the
    ///      revert that followed it.
    function _assertMovedContinuously(uint256 previous, uint256 next, string memory reason) internal pure {
        uint256 _delta = next > previous ? next - previous : previous - next;
        assertLe(_delta * BPS_MAX, previous * GUARDRAIL_BPS, reason);
    }
}

/// @title  Manual withdrawal
/// @notice The state Maple's delegate can put the Safe into at any moment: `isManualWithdrawal[SAFE]`, where
///         servicing a request deletes its queue entry and moves no assets at all.
/// @dev    H1. The pool tokens stay on the withdrawal manager, credited to `lockedShares`, so they are absent
///         from the Safe's balance, from `requests(id)` and from the idle balance simultaneously -- and the
///         exchange rate does not move, so the rate band would refuse nothing. The fourth NAV term is the only
///         thing between that state and a vault deadlocked while holders are exiting. v2.0.0 dropped v1's
///         precondition that the owner hold no open requests, so the flag can be flipped mid-exit, which is the
///         ordering these tests use.
contract SyrupNavManagerManualWithdrawalTest is SyrupNavManagerTestBase {
    uint256 internal constant GUARDRAIL_BPS = 100;

    uint256 internal deployedShares;

    function setUp() public override {
        super.setUp();
        _deploy(100_000e6);
        deployedShares = pool.balanceOf(address(safe));
    }

    function test_PreviewNav_IsContinuousAcrossManualWithdrawalService() public {
        uint256 _requestId = _request(deployedShares);
        withdrawalManager.setManualWithdrawal(address(safe), true);

        uint256 _navBefore = manager.previewNav();
        uint256 _idleBefore = asset.balanceOf(address(safe));

        _fundPoolLiquidity(500_000e6);
        withdrawalManager.processRedemptions(deployedShares);

        (address _owner, uint256 _queued) = withdrawalManager.requests(_requestId);
        assertEq(_owner, address(0), "the queue entry was deleted");
        assertEq(_queued, 0, "with nothing left on it");
        assertEq(asset.balanceOf(address(safe)), _idleBefore, "and not one asset moved");

        (uint256 _idle, uint256 _held, uint256 _escrowed, uint256 _manual) = manager.navComponents();
        assertEq(manager.escrowedShares(), 0, "the escrow term cannot see the position: its entry is gone");
        assertEq(_escrowed, 0, "so the third component is zero");
        assertEq(_held, 0, "and the shares are not in the Safe either");
        assertEq(manager.manualShares(), deployedShares, "they are in the manual bucket");
        assertGt(_manual, 0, "which is what the fourth component values");
        assertApproxEqAbs(_idle + _held + _escrowed + _manual, _navBefore, 2, "NAV continuous across the service");
        assertApproxEqAbs(manager.previewNav(), _navBefore, 2, "and previewNav agrees");
    }

    /// @dev The same scenario against the value-sensitive guardrail: not merely "the NAV is unchanged" but "the
    ///      vault still accepts it", which is the failure H1 describes.
    function test_PushNav_IsAcceptedAcrossManualWithdrawalService() public {
        vault.setMaxMoveBps(GUARDRAIL_BPS);

        vm.prank(keeper);
        uint256 _beforeService = manager.pushNav();
        skip(PUSH_COOLDOWN + 1);

        _serviceIntoTheManualBucket();

        vm.prank(keeper);
        uint256 _afterService = manager.pushNav();

        assertEq(vault.proposalCount(), 2, "the guardrail accepted the post-service push");
        assertEq(manager.manualShares(), deployedShares, "with the whole position sitting in the manual bucket");
        uint256 _delta =
            _afterService > _beforeService ? _afterService - _beforeService : _beforeService - _afterService;
        assertLe(_delta * BPS_MAX, _beforeService * GUARDRAIL_BPS, "and the proposed value moved continuously");
    }

    /// @dev The recovery path. Valuation was never wrong while the shares sat in the bucket, so this is about
    ///      liquidity: the assets come back to the Safe and the NAV does not move.
    function test_RedeemManual_DrainsTheBucketIntoTheSafe() public {
        _serviceIntoTheManualBucket();

        uint256 _navBefore = manager.previewNav();
        uint256 _idleBefore = asset.balanceOf(address(safe));
        uint256 _expectedAssets = pool.convertToExitAssets(deployedShares);

        vm.expectEmit(true, true, true, true, address(manager));
        emit SyrupNavManager.ManualRedeemed(deployedShares, _expectedAssets);

        vm.prank(keeper);
        uint256 _received = manager.redeemManual(deployedShares);

        assertEq(_received, _expectedAssets, "the Safe received the bucket's exit value");
        assertEq(asset.balanceOf(address(safe)), _idleBefore + _expectedAssets, "as idle assets");
        assertEq(manager.manualShares(), 0, "bucket drained");
        assertApproxEqAbs(manager.previewNav(), _navBefore, 2, "and the NAV is conserved by the drain");
        assertEq(manager.openRequests().length, 0, "the settled entry is no longer tracked");
    }

    function test_RedeemManual_RevertWhen_SharesExceedTheBucket() public {
        _serviceIntoTheManualBucket();
        uint256 _available = manager.manualShares();

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(SyrupNavManager.InsufficientPoolShares.selector, _available + 1, _available)
        );
        manager.redeemManual(_available + 1);
    }

    function test_RedeemManual_RevertWhen_SharesAreZero() public {
        vm.prank(keeper);
        vm.expectRevert(SyrupNavManager.ZeroAmount.selector);
        manager.redeemManual(0);
    }

    function test_RedeemManual_RevertWhen_CallerLacksTheRole() public {
        bytes32 _role = manager.NAV_REDEEM();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), stranger));
        manager.redeemManual(1);
    }

    /// @dev Queues the Safe's whole position, flags it manual mid-exit, then has the delegate service it -- the
    ///      entry disappears and the shares land in the manual bucket.
    function _serviceIntoTheManualBucket() internal {
        _request(deployedShares);
        withdrawalManager.setManualWithdrawal(address(safe), true);
        _fundPoolLiquidity(500_000e6);
        withdrawalManager.processRedemptions(deployedShares);
    }
}

/// @title  Withdrawal-manager rotation
/// @notice Maple's pool delegate can replace the pool's withdrawal manager while this manager has requests open.
/// @dev    M3. Every tracked id reads `(0, 0)` on a new manager, so `_prune` would drop them all and the escrow
///         term would collapse to zero with the exchange rate still inside its band -- the same blast radius as
///         H1, a different trigger. The manager pins the withdrawal manager its ids belong to and fails closed,
///         turning a silent understatement of arbitrary size into a liveness stop a guardian has to clear.
contract SyrupNavManagerRotationTest is SyrupNavManagerTestBase {
    SyrupWithdrawalManager internal previousWithdrawalManager;

    function setUp() public override {
        super.setUp();
        _deploy(400_000e6);
        previousWithdrawalManager = withdrawalManager;
    }

    /// @dev Fails closed on every surface, not just on the push: a valuation read that answered while a
    ///      rotation was pending would be answering with the escrow term missing.
    function test_PushNav_RevertWhen_WithdrawalManagerRotated() public {
        uint256 _shares = pool.balanceOf(address(safe)) / 2;
        _request(_shares);

        SyrupWithdrawalManager _current = _rotate();
        bytes memory _expected = abi.encodeWithSelector(
            SyrupNavManager.WithdrawalManagerRotated.selector, address(previousWithdrawalManager), address(_current)
        );

        vm.prank(keeper);
        vm.expectRevert(_expected);
        manager.pushNav();

        vm.expectRevert(_expected);
        manager.previewNav();

        vm.expectRevert(_expected);
        manager.escrowedShares();

        vm.prank(keeper);
        vm.expectRevert(_expected);
        manager.requestRedeem(_shares);
    }

    /// @dev A keeper reads this and pages a human rather than retrying, so it has to name both managers.
    function test_WithdrawalManagerRotated_ReportsTheRotation() public {
        _request(pool.balanceOf(address(safe)) / 2);

        (bool _rotatedBefore, address _trackedBefore, address _currentBefore) = manager.withdrawalManagerRotated();
        assertFalse(_rotatedBefore, "nothing has rotated yet");
        assertEq(_trackedBefore, address(previousWithdrawalManager), "the pin names the manager holding the shares");
        assertEq(_currentBefore, address(previousWithdrawalManager), "which is still the pool's");

        SyrupWithdrawalManager _current = _rotate();

        (bool _rotated, address _tracked, address _currentReported) = manager.withdrawalManagerRotated();
        assertTrue(_rotated, "the view reports the rotation");
        assertEq(_tracked, address(previousWithdrawalManager), "still naming the manager the ids belong to");
        assertEq(_currentReported, address(_current), "and the one the pool now points at");
    }

    /// @dev The way out, and it is not an override: the previous manager must report every tracked request
    ///      settled and an empty manual bucket, which is exactly the state in which those assets have already
    ///      landed in the Safe and are counted as idle.
    function test_ResolveWithdrawalManagerRotation_ClearsTrackedRequestsOnceSettled() public {
        uint256 _shares = pool.balanceOf(address(safe));
        _request(_shares);

        // Settled on the OLD manager, so the proceeds are already idle in the Safe when the rotation happens.
        _fundPoolLiquidity(500_000e6);
        previousWithdrawalManager.processRedemptions(_shares);

        SyrupWithdrawalManager _current = _rotate();

        vm.expectEmit(true, true, true, true, address(manager));
        emit SyrupNavManager.WithdrawalManagerRotationResolved(address(previousWithdrawalManager), address(_current));
        vm.prank(guardian);
        manager.resolveWithdrawalManagerRotation();

        (bool _rotated,, address _currentReported) = manager.withdrawalManagerRotated();
        assertFalse(_rotated, "no rotation pending any more");
        assertEq(_currentReported, address(_current), "the pool's manager is the new one");
        assertEq(manager.openRequests().length, 0, "the tracked ids are gone");
        assertEq(manager.escrowedShares(), 0, "and nothing is escrowed");
        assertGe(manager.previewNav(), 1_000_000e6, "valuation reads work again, with the proceeds counted idle");
    }

    /// @dev Refusing while the old manager still owes is the whole point: resolving there would drop a live
    ///      position out of the NAV, which is the outcome the rotation guard exists to prevent.
    function test_ResolveWithdrawalManagerRotation_RevertWhen_PreviousManagerStillOwes() public {
        uint256 _shares = pool.balanceOf(address(safe)) / 2;
        uint256 _requestId = _request(_shares);

        _rotate();

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.RotationHasLiveRequests.selector, _requestId, _shares));
        manager.resolveWithdrawalManagerRotation();
    }

    function test_ResolveWithdrawalManagerRotation_RevertWhen_NoRotationPending() public {
        _request(pool.balanceOf(address(safe)) / 2);

        vm.prank(guardian);
        vm.expectRevert(SyrupNavManager.NoRotationToResolve.selector);
        manager.resolveWithdrawalManagerRotation();
    }

    function test_ResolveWithdrawalManagerRotation_RevertWhen_CallerIsNotGuardian() public {
        _request(pool.balanceOf(address(safe)) / 2);
        _rotate();

        bytes32 _role = manager.NAV_ACKNOWLEDGE();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SyrupNavManager.MissingRole.selector, _role, address(manager), keeper));
        manager.resolveWithdrawalManagerRotation();
    }

    /// @dev Pruning is the one permissionless entry point, so it is the one that could do the damage quietly: a
    ///      prune resolved against the new manager would drop every tracked id, emit `RequestCleared` for each,
    ///      and leave an empty set with nothing recording that the position had been lost.
    function test_PruneRequests_RevertWhen_WithdrawalManagerRotated() public {
        uint256 _requestId = _request(pool.balanceOf(address(safe)) / 2);
        SyrupWithdrawalManager _current = _rotate();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                SyrupNavManager.WithdrawalManagerRotated.selector, address(previousWithdrawalManager), address(_current)
            )
        );
        manager.pruneRequests();

        (bool _rotated,,) = manager.withdrawalManagerRotated();
        assertTrue(_rotated, "the rotation is still pending");
        assertEq(manager.openRequests().length, 1, "and the tracked id was not dropped");
        assertEq(manager.openRequests()[0], _requestId, "it is still the id the request was opened under");
    }

    /// @dev Rotates the pool's withdrawal manager, which the pool delegate can do at any time. The manager mock
    ///      exposes a setter rather than a factory so its own bytecode stays under the EIP-170 limit, so the
    ///      new manager is deployed here and wired in.
    function _rotate() internal returns (SyrupWithdrawalManager current) {
        current = new SyrupWithdrawalManager(address(pool), address(poolManager));
        poolManager.setWithdrawalManager(address(current));
        assertTrue(address(current) != address(previousWithdrawalManager), "the pool points at a new manager");
    }
}
