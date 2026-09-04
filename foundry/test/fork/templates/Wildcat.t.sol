// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev `MarketState` as returned by `WildcatMarket.currentState()`. Only
///      `pendingWithdrawalExpiry` is read here, but the whole struct has to be declared for
///      the return decode to line up.
struct MarketState {
    bool isClosed;
    uint128 maxTotalSupply;
    uint128 accruedProtocolFees;
    uint128 normalizedUnclaimedWithdrawals;
    uint104 scaledTotalSupply;
    uint104 scaledPendingWithdrawals;
    uint32 pendingWithdrawalExpiry;
    bool isDelinquent;
    uint32 timeDelinquent;
    uint16 protocolFeeBips;
    uint16 annualInterestBips;
    uint16 reserveRatioBips;
    uint112 scaleFactor;
    uint32 lastInterestAccruedTimestamp;
}

/// @dev Lender-side surface of a Wildcat V2 market. The first five functions are the ones
///      `wildcat.tmpl` grants; the block below them are real market functions deliberately
///      left OUT of the policy (used as negative cases).
interface IWildcatMarket {
    function depositUpTo(uint256 amount) external returns (uint256);
    function deposit(uint256 amount) external;
    function queueWithdrawal(uint256 amount) external returns (uint32);
    function queueFullWithdrawal() external returns (uint32);
    function executeWithdrawal(address accountAddress, uint32 expiry) external returns (uint256);
    // Not in policy:
    function executeWithdrawals(address[] calldata accountAddresses, uint32[] calldata expiries)
        external
        returns (uint256[] memory);
    function borrow(uint256 amount) external;
    function repay(uint256 amount) external;
    function closeMarket() external;
    function updateState() external;
    function collectFees() external;
    function rescueTokens(address token) external;
    // Views used by the lifecycle test.
    function currentState() external view returns (MarketState memory);
    function getAvailableWithdrawalAmount(address accountAddress, uint32 expiry) external view returns (uint256);
    function maximumDeposit() external view returns (uint256);
    function isClosed() external view returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev `HookedMarket` as stored by the market's `OpenTermHooks` instance.
struct HookedMarket {
    bool isHooked;
    bool transferRequiresAccess;
    bool depositRequiresAccess;
    uint128 minimumDeposit;
    bool transfersDisabled;
}

interface IOpenTermHooks {
    /// @dev Callable only by a registered role provider — the lifecycle test pranks the one
    ///      already registered on the live hooks instance.
    function grantRole(address account, uint32 roleGrantedTimestamp) external;
    function getHookedMarket(address market) external view returns (HookedMarket memory);
}

/// @title  WildcatRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/wildcat/wildcat.tmpl` policy
///         (lender side), driven by the shared `ZacForkTest` harness.
/// @dev    Coverage matrix — for every call the policy grants:
///           • one happy-path test (in-scope params clear the gate), and
///           • one out-of-scope test per scoped parameter.
///         Plus a block of non-allowed-method / non-allowed-target rejections, and one
///         end-to-end lifecycle test that really moves funds.
///
///         Allowed calls (policy from `wintermute_weth`):
///           WETH.approve(spender ∈ {MARKET}, amount=pass)
///           MARKET.depositUpTo(amount=pass)
///           MARKET.deposit(amount=pass)
///           MARKET.queueWithdrawal(amount=pass)
///           MARKET.queueFullWithdrawal()
///           MARKET.executeWithdrawal(accountAddress=avatar, expiry=pass)
///
///         Happy paths for the non-executable market calls use `shouldRevert=false`: a policy
///         rejection still reverts (`ConditionViolation`), while a protocol-level revert is
///         swallowed to `ok=false`. So a call that does NOT revert proves the policy gate
///         allowed it (see `_assertPolicyAllows`). `approve` is genuinely executable, so its
///         happy path asserts the resulting allowance instead.
///
///         `test_lifecycle_depositQueueWarpClaim` is the one test that does not stop at the
///         gate: it authorises the Safe as a lender, deposits real WETH, queues the exit,
///         warps past the batch expiry and claims — every step through
///         `execTransactionWithRole`. That is what proves the policy is *sufficient* and not
///         merely safe.
contract WildcatRoleMainnetTest is ZacForkTest {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    /// Wildcat V2 "Wintermute Trading Wrapped Ether" market (aliases.wildcat.wintermute_weth).
    address constant MARKET = 0xBAd1b632E90Ce02af868f07c572adB067eB98353;
    /// The market's `OpenTermHooks` instance — the top 160 bits of `MARKET.hooks()`.
    address constant HOOKS = 0xec6F30250269069B62D7b969a6AF731214D20AF9;
    /// A role provider already registered on `HOOKS`, so `grantRole` from it is accepted.
    address constant ROLE_PROVIDER = 0x5620553d8881335F74AD19259daaCD1d9B373101;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint256 constant AMOUNT = 1e18; // 1 WETH; `amount` is `pass` everywhere.
    uint32 constant EXPIRY = 1_800_000_000; // Arbitrary batch id; `expiry` is `pass`.

    /// @dev `encodeKey('WILDCAT')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x57494c4443415400000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "wildcat.zac.yaml");
    }

    // ============================================================
    // approve(spender, amount) on WETH — scoped param: spender
    // ============================================================

    /// happy: approve the in-scope market to pull WETH. This one executes for real.
    function test_approve_happy_market() public {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr)
            .execTransactionWithRole(WETH, 0, abi.encodeCall(IERC20.approve, (MARKET, AMOUNT)), CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
        assertEq(IERC20(WETH).allowance(safeAddr, MARKET), AMOUNT, "Safe -> market allowance did not update");
    }

    /// out-of-scope `spender`: approving any non-market spender is rejected.
    function test_approve_wrongSpender_rejected() public {
        expectPolicyReject(modAddr, ALICE, WETH, abi.encodeCall(IERC20.approve, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ============================================================
    // depositUpTo(amount) / deposit(amount) — no scoped params (amount=pass)
    // ============================================================

    function test_depositUpTo_happy() public {
        _assertPolicyAllows(MARKET, abi.encodeCall(IWildcatMarket.depositUpTo, (AMOUNT)));
    }

    function test_deposit_happy() public {
        _assertPolicyAllows(MARKET, abi.encodeCall(IWildcatMarket.deposit, (AMOUNT)));
    }

    /// A Wildcat market forwards any calldata past its declared arguments to its hooks
    /// contract as `hooksData`, which is how a signature-based role provider authorises a
    /// lender. Roles V2 scopes by ABI position and puts no upper bound on calldata length,
    /// so the same role admits the longer call — pinned here because the policy would
    /// silently block that authorisation path if it did not.
    function test_deposit_withTrailingHooksData_allowed() public {
        bytes memory withHooksData = abi.encodePacked(abi.encodeCall(IWildcatMarket.deposit, (AMOUNT)), hex"c0ffee");
        _assertPolicyAllows(MARKET, withHooksData);
    }

    // ============================================================
    // queueWithdrawal(amount) / queueFullWithdrawal() — no scoped params
    // ============================================================

    function test_queueWithdrawal_happy() public {
        _assertPolicyAllows(MARKET, abi.encodeCall(IWildcatMarket.queueWithdrawal, (AMOUNT)));
    }

    function test_queueFullWithdrawal_happy() public {
        _assertPolicyAllows(MARKET, abi.encodeCall(IWildcatMarket.queueFullWithdrawal, ()));
    }

    // ============================================================
    // executeWithdrawal(accountAddress, expiry) — scoped param: accountAddress = avatar
    // ============================================================

    function test_executeWithdrawal_happy_avatar() public {
        _assertPolicyAllows(MARKET, abi.encodeCall(IWildcatMarket.executeWithdrawal, (safeAddr, EXPIRY)));
    }

    /// out-of-scope `accountAddress`: claiming a batch out to anyone but the Safe is rejected,
    /// so the policy can never be used to settle a third party's withdrawal.
    function test_executeWithdrawal_wrongAccount_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, MARKET, abi.encodeCall(IWildcatMarket.executeWithdrawal, (BOGUS, EXPIRY)), CALL, ROLE_KEY
        );
    }

    // ============================================================
    // Non-allowed methods (allowed target, selector NOT in policy)
    // ============================================================

    /// The batch-claim variant is left out of the policy: its `accountAddresses` array cannot
    /// be pinned to the avatar, so granting it would let the Safe settle arbitrary lenders.
    function test_nonAllowed_executeWithdrawals_rejected() public {
        address[] memory accounts = new address[](1);
        accounts[0] = safeAddr;
        uint32[] memory expiries = new uint32[](1);
        expiries[0] = EXPIRY;
        expectPolicyReject(
            modAddr,
            ALICE,
            MARKET,
            abi.encodeCall(IWildcatMarket.executeWithdrawals, (accounts, expiries)),
            CALL,
            ROLE_KEY
        );
    }

    /// `borrow` is `onlyBorrower` on the market, and never part of a lender policy.
    function test_nonAllowed_borrow_rejected() public {
        expectPolicyReject(modAddr, ALICE, MARKET, abi.encodeCall(IWildcatMarket.borrow, (AMOUNT)), CALL, ROLE_KEY);
    }

    /// `repay` is permissionless on the market — granting it would let the Safe hand its
    /// underlying to the borrower's debt as an unrecoverable gift.
    function test_nonAllowed_repay_rejected() public {
        expectPolicyReject(modAddr, ALICE, MARKET, abi.encodeCall(IWildcatMarket.repay, (AMOUNT)), CALL, ROLE_KEY);
    }

    function test_nonAllowed_closeMarket_rejected() public {
        expectPolicyReject(modAddr, ALICE, MARKET, abi.encodeCall(IWildcatMarket.closeMarket, ()), CALL, ROLE_KEY);
    }

    /// `updateState` and `collectFees` are permissionless — any address can call them, so the
    /// Safe gains nothing from holding the grant and the policy stays minimal.
    function test_nonAllowed_updateState_rejected() public {
        expectPolicyReject(modAddr, ALICE, MARKET, abi.encodeCall(IWildcatMarket.updateState, ()), CALL, ROLE_KEY);
    }

    function test_nonAllowed_collectFees_rejected() public {
        expectPolicyReject(modAddr, ALICE, MARKET, abi.encodeCall(IWildcatMarket.collectFees, ()), CALL, ROLE_KEY);
    }

    /// The market contract is itself the position token. Moving it off the Safe is exactly
    /// what this policy exists to prevent, so neither `transfer` nor `approve` is granted on
    /// the market — even though `approve` IS granted on the underlying.
    function test_nonAllowed_marketTokenTransfer_rejected() public {
        expectPolicyReject(modAddr, ALICE, MARKET, abi.encodeCall(IERC20.transfer, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    function test_nonAllowed_marketTokenApprove_rejected() public {
        expectPolicyReject(modAddr, ALICE, MARKET, abi.encodeCall(IERC20.approve, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    /// On WETH only `approve` is granted — `transfer` (a different selector) is rejected.
    function test_nonAllowed_wethTransfer_rejected() public {
        expectPolicyReject(modAddr, ALICE, WETH, abi.encodeCall(IERC20.transfer, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ============================================================
    // Non-allowed targets (correct selector, target NOT in policy)
    // ============================================================

    /// `approve` is only scoped on WETH; the same selector on a different token is rejected.
    function test_nonAllowedTarget_approveOtherToken_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (MARKET, AMOUNT)), CALL, ROLE_KEY);
    }

    /// An allowed selector aimed at an entirely out-of-policy target is rejected.
    function test_nonAllowedTarget_deposit_rejected() public {
        expectPolicyReject(modAddr, ALICE, BOGUS, abi.encodeCall(IWildcatMarket.deposit, (AMOUNT)), CALL, ROLE_KEY);
    }

    /// The hooks instance governs lender authorisation but is not a policy target: the Safe
    /// must never be able to grant itself a credential.
    function test_nonAllowedTarget_hooksGrantRole_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            HOOKS,
            abi.encodeCall(IOpenTermHooks.grantRole, (safeAddr, uint32(block.timestamp))),
            CALL,
            ROLE_KEY
        );
    }

    /// `queueWithdrawal` aimed at the underlying (wrong venue) is rejected.
    function test_nonAllowedTarget_queueWithdrawalOnToken_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, WETH, abi.encodeCall(IWildcatMarket.queueWithdrawal, (AMOUNT)), CALL, ROLE_KEY
        );
    }

    // ============================================================
    // End-to-end lifecycle: deposit -> queue -> warp -> claim
    // ============================================================

    /// The full lender round trip, every step routed through `execTransactionWithRole`, so a
    /// missing grant fails the test rather than passing silently.
    ///
    /// Two pieces of setup are NOT part of the policy and are staged directly:
    ///   • the Safe is authorised as a lender by pranking the role provider already
    ///     registered on the live hooks instance. On the real market this authorisation is
    ///     the borrower's to give; the policy neither needs nor grants it (asserted by
    ///     `test_nonAllowedTarget_hooksGrantRole_rejected`).
    ///   • the Safe is funded with WETH via `deal`.
    ///
    /// The wait between queue and claim is the market's own `withdrawalBatchDuration`, read
    /// off the batch's returned expiry rather than assumed — the live wmtWETH market's is
    /// 24h, not the 48h `delinquencyGracePeriod`.
    function test_lifecycle_depositQueueWarpClaim() public {
        HookedMarket memory hooked = IOpenTermHooks(HOOKS).getHookedMarket(MARKET);
        uint256 depositAmount = hooked.minimumDeposit > AMOUNT ? hooked.minimumDeposit : AMOUNT;

        // Preconditions that depend on live market state. The fork suite deliberately runs at
        // chain head, so a market that has closed or filled its cap makes the deposit path
        // untestable — skip loudly instead of failing on protocol drift.
        vm.skip(IWildcatMarket(MARKET).isClosed(), "market is closed on this fork");
        vm.skip(
            IWildcatMarket(MARKET).maximumDeposit() < depositAmount,
            "market has less remaining capacity than its own minimum deposit"
        );

        // --- setup outside the policy ---
        vm.prank(ROLE_PROVIDER);
        IOpenTermHooks(HOOKS).grantRole(safeAddr, uint32(block.timestamp));
        deal(WETH, safeAddr, depositAmount);

        // --- 1. approve the market to pull the underlying ---
        _exec(WETH, abi.encodeCall(IERC20.approve, (MARKET, depositAmount)));
        assertEq(IERC20(WETH).allowance(safeAddr, MARKET), depositAmount, "allowance not set");

        // --- 2. deposit ---
        _exec(MARKET, abi.encodeCall(IWildcatMarket.deposit, (depositAmount)));
        assertEq(IERC20(WETH).balanceOf(safeAddr), 0, "underlying was not pulled");
        assertApproxEqAbs(
            IWildcatMarket(MARKET).balanceOf(safeAddr), depositAmount, 1e6, "market tokens not minted to the Safe"
        );

        // --- 3. queue the exit ---
        _exec(MARKET, abi.encodeCall(IWildcatMarket.queueFullWithdrawal, ()));
        // `execTransactionWithRole` only forwards the success flag, so the batch id comes from
        // market state rather than `queueFullWithdrawal`'s return value.
        uint32 expiry = IWildcatMarket(MARKET).currentState().pendingWithdrawalExpiry;
        assertGt(uint256(expiry), block.timestamp, "no pending withdrawal batch was opened");

        // --- 4. claiming before the batch expires is refused by the MARKET, not the policy ---
        bool okEarly = _tryExec(MARKET, abi.encodeCall(IWildcatMarket.executeWithdrawal, (safeAddr, expiry)));
        assertFalse(okEarly, "claim succeeded before the batch expired");

        // --- 5. warp past the batch window and claim ---
        vm.warp(uint256(expiry) + 1);
        uint256 available = IWildcatMarket(MARKET).getAvailableWithdrawalAmount(safeAddr, expiry);
        assertGt(available, 0, "batch paid nothing to the Safe");
        assertLe(available, depositAmount, "batch paid out more than was deposited");

        _exec(MARKET, abi.encodeCall(IWildcatMarket.executeWithdrawal, (safeAddr, expiry)));
        assertEq(IERC20(WETH).balanceOf(safeAddr), available, "claimed amount did not reach the Safe");
    }

    // ============================================================
    // Helpers
    // ============================================================

    /// @dev Assert the policy gate ALLOWS `data` to `to`. Uses `shouldRevert=false` so a
    ///      protocol-level revert is swallowed to `ok=false`; only a policy rejection would
    ///      revert (`ConditionViolation`). Reaching the end without reverting ⇒ allowed.
    function _assertPolicyAllows(address to, bytes memory data) internal {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(to, 0, data, CALL, ROLE_KEY, false);
    }

    /// @dev Execute `data` against `to` for real, through the Modifier, and require it to
    ///      succeed end to end (`shouldRevert=true`, so a protocol revert fails the test too).
    function _exec(address to, bytes memory data) internal {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr).execTransactionWithRole(to, 0, data, CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
    }

    /// @dev Execute `data` through the Modifier with `shouldRevert=false`, returning the
    ///      Modifier's success flag so the caller can assert a protocol-level failure. A
    ///      POLICY rejection would still revert, so `false` here means the call cleared the
    ///      gate and the target refused it.
    function _tryExec(address to, bytes memory data) internal returns (bool) {
        vm.prank(ALICE);
        return IRoles(modAddr).execTransactionWithRole(to, 0, data, CALL, ROLE_KEY, false);
    }
}
