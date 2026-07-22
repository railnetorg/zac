// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";
import {MilkmanSwapManager, IMilkman} from "src/MilkmanSwapManager.sol";

/// @dev Minimal ERC20 surface used by the assertions.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title  MilkmanWrapperRoleMainnetTest
/// @notice Mainnet-fork acceptance test for `templates/milkman_wrapper/milkman_wrapper.tmpl` —
///         the wrapper-gated Milkman policy (RAIL-28). Unlike `milkman.tmpl` (which authorised
///         the Safe → Milkman directly), this policy authorises ONLY the `MilkmanSwapManager`
///         wrapper: approve `spender == wrapper`, and `wrapper.openSwap` / `wrapper.cancelSwap`.
/// @dev    Enforces the registry-completeness invariant: every swap must enter through the wrapper
///         (so its in-flight amount stays visible to NAV), therefore the policy grants NOTHING on
///         Milkman and NOTHING on any spender but the wrapper.
///
///         `deployRolesFixture` stands up a Safe + Roles V2 Modifier; the test deploys a fresh
///         `MilkmanSwapManager` bound to that Safe, then `applyConfigFile` renders + applies the
///         `milkman_wrapper.zac.yaml` fixture with `__WRAPPER__` substituted to the deployed
///         wrapper. Requires `MAINNET_RPC_URL` (contracts-fork profile).
///
///         Fixture pairs (identical caps/feeds to the milkman.tmpl fork test, so the per-pair
///         slippage + Chainlink-feed pinning is exercised the same way):
///           USDC → PYUSD, slippage ≤ 500 bps
///           USDC → RLUSD, slippage ≤ 700 bps
///         `openSwap` has NO `to` parameter (the wrapper hardcodes the CoW receiver to its Safe),
///         and `expectedCloneAddress` is `pass` (bound atomically in-contract). "Allow" tests use
///         `shouldRevert=false`: the policy gate is the only assertion — the wrapper's inner call
///         may fail on the fork (no funds), but a gate rejection would revert regardless.
contract MilkmanWrapperRoleMainnetTest is ZacForkTest {
    address constant MILKMAN = 0x060373D064d0168931dE2AB8DDA7410923d06E88;
    address constant PRICE_CHECKER = 0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c;

    // Allowed tokens (fixture pairs: USDC→PYUSD ≤5%, USDC→RLUSD ≤7%).
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // fromToken ✓
    address constant PYUSD = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8; // toToken   ✓ (cap 500)
    address constant RLUSD = 0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD; // toToken   ✓ (cap 700)

    // Blocked tokens (no branch covers them).
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // fromToken ✗
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // toToken   ✗

    // Feeds the policy pins, per pair (USDC/USD → dest/USD path). Aave
    // PriceCapAdapterStable adapters, not the raw Chainlink aggregators.
    address constant USDC_USD = 0x3f73F03aa83B2A48ed27E964eD0fDb590332095B;
    address constant PYUSD_USD = 0x36964C0579D02E0a5AaAb89E24Cf8d7CDF3549EE;
    address constant RLUSD_USD = 0xf0eaC18E908B34770FDEe46d069c846bDa866759;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant ARBITRARY_SPENDER = 0x000000000000000000000000000000000000dEaD;
    address constant WRONG_CHECKER = 0x000000000000000000000000000000000000bEEF;
    address constant ATTACKER_FEED = 0x000000000000000000000000000000000000FEeD;
    uint8 constant CALL = 0;
    uint256 constant AMOUNT = 1_000e6;

    /// @dev `encodeKey('STRATEGY_MANAGER')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x53545241544547595f4d414e4147455200000000000000000000000000000000;

    address safeAddr;
    address modAddr;
    MilkmanSwapManager wrapper;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        // Deploy the wrapper bound to the fixture Safe, then substitute its address into the policy.
        wrapper = new MilkmanSwapManager(IMilkman(MILKMAN), safeAddr);

        string[] memory keys = new string[](1);
        string[] memory vals = new string[](1);
        keys[0] = "__WRAPPER__";
        vals[0] = vm.toString(address(wrapper));
        applyConfigFile(fx, ALICE, "milkman_wrapper.zac.yaml", keys, vals);
    }

    // ==================== approve: spender == wrapper, amount < uint256.max ====================

    /// WF-1 — allow: approve USDC to the WRAPPER for a normal amount; allowance is set.
    function test_WF1_ApproveWrapperAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(USDC, 0, _approveCd(address(wrapper), AMOUNT), CALL, ROLE_KEY, true);
        assertEq(IERC20(USDC).allowance(safeAddr, address(wrapper)), AMOUNT, "allowance not set");
    }

    /// WF-2 — deny: approving MILKMAN directly is rejected. This is the registry-completeness
    ///        invariant — funds may only ever be approved to the wrapper, never to Milkman, so no
    ///        swap can bypass the wrapper and hide its in-flight amount from NAV.
    function test_WF2_ApproveMilkmanRejected() public {
        _expectReject(USDC, _approveCd(MILKMAN, AMOUNT));
    }

    /// WF-3 — deny: approving any other spender breaches `equal_to wrapper`.
    function test_WF3_ApproveArbitrarySpenderRejected() public {
        _expectReject(USDC, _approveCd(ARBITRARY_SPENDER, AMOUNT));
    }

    /// WF-4 — deny: amount == uint256.max (infinite approval) breaches the `less_than` cap.
    function test_WF4_ApproveUnlimitedRejected() public {
        _expectReject(USDC, _approveCd(address(wrapper), type(uint256).max));
    }

    /// WF-5 — deny: approve is scoped on USDC only; approving an unlisted token (PYUSD) to the
    ///        wrapper hits no permission and is rejected.
    function test_WF5_ApproveUnlistedTokenRejected() public {
        _expectReject(PYUSD, _approveCd(address(wrapper), AMOUNT));
    }

    // ==================== openSwap on the wrapper: per-pair branch + slippage cap ====================

    /// WF-6 — allow: USDC → PYUSD at 200 bps (≤ 500 cap) with the pinned feed path.
    function test_WF6_OpenSwapPyusdWithinCapAllowed() public {
        _openSwapAllowed(USDC, PYUSD, _pcd(200, _innerPyusd()));
    }

    /// WF-7 — allow: USDC → RLUSD at 600 bps (≤ 700 cap) with the pinned feed path.
    function test_WF7_OpenSwapRlusdWithinCapAllowed() public {
        _openSwapAllowed(USDC, RLUSD, _pcd(600, _innerRlusd()));
    }

    /// WF-8 — allow: slippage exactly at the cap (500 bps) clears `less_than 501`.
    function test_WF8_OpenSwapPyusdAtCapAllowed() public {
        _openSwapAllowed(USDC, PYUSD, _pcd(500, _innerPyusd()));
    }

    /// WF-9 — deny: USDC → PYUSD at 501 bps exceeds the 500 bps cap.
    function test_WF9_OpenSwapPyusdOverCapRejected() public {
        _expectReject(address(wrapper), _openSwap(USDC, PYUSD, PRICE_CHECKER, _pcd(501, _innerPyusd())));
    }

    /// WF-10 — deny: USDC → PYUSD at 600 bps. Fine for RLUSD (cap 700) but not PYUSD (cap 500):
    ///         the cap is correlated to the exact pair, so no branch matches.
    function test_WF10_OpenSwapPyusdWithRlusdCapRejected() public {
        _expectReject(address(wrapper), _openSwap(USDC, PYUSD, PRICE_CHECKER, _pcd(600, _innerPyusd())));
    }

    /// WF-11 — deny: toToken WETH is covered by no branch.
    function test_WF11_OpenSwapToUnlistedTokenRejected() public {
        _expectReject(address(wrapper), _openSwap(USDC, WETH, PRICE_CHECKER, _pcd(200, _innerPyusd())));
    }

    /// WF-12 — deny: fromToken USDT is covered by no branch.
    function test_WF12_OpenSwapFromUnlistedTokenRejected() public {
        _expectReject(address(wrapper), _openSwap(USDT, PYUSD, PRICE_CHECKER, _pcd(200, _innerPyusd())));
    }

    /// WF-13 — deny: priceChecker is pinned in every branch; a substitute is rejected.
    function test_WF13_OpenSwapWrongPriceCheckerRejected() public {
        _expectReject(address(wrapper), _openSwap(USDC, PYUSD, WRONG_CHECKER, _pcd(200, _innerPyusd())));
    }

    /// WF-14 — deny: a structurally valid feed config pointing at an attacker-chosen "feed" (the
    ///         ≈0 fair-price drain vector) is rejected within cap — only the pinned path clears.
    function test_WF14_OpenSwapAttackerFeedRejected() public {
        bytes memory pcd = _pcd(200, _inner(USDC_USD, ATTACKER_FEED));
        _expectReject(address(wrapper), _openSwap(USDC, PYUSD, PRICE_CHECKER, pcd));
    }

    /// WF-15 — deny: feeds are bound to the exact pair. USDC → PYUSD with the RLUSD feed path
    ///         matches neither branch (PYUSD branch wants PYUSD feeds; RLUSD branch wants RLUSD toToken).
    function test_WF15_OpenSwapMismatchedPairFeedsRejected() public {
        _expectReject(address(wrapper), _openSwap(USDC, PYUSD, PRICE_CHECKER, _pcd(200, _innerRlusd())));
    }

    // ==================== the wrapper-gate invariant: Milkman is unreachable ====================

    /// WF-16 — deny: calling `requestSwapExactTokensForTokens` on MILKMAN directly is rejected —
    ///         the policy grants no permission on Milkman at all, so the target is unauthorised.
    ///         Even a perfectly-formed, within-cap request cannot bypass the wrapper.
    function test_WF16_MilkmanDirectRequestSwapRejected() public {
        bytes memory cd = abi.encodeWithSignature(
            "requestSwapExactTokensForTokens(uint256,address,address,address,bytes32,address,bytes)",
            AMOUNT,
            USDC,
            PYUSD,
            safeAddr,
            bytes32(0),
            PRICE_CHECKER,
            _pcd(200, _innerPyusd())
        );
        _expectReject(MILKMAN, cd);
    }

    // ==================== cancelSwap: authorised on the wrapper ====================

    /// WF-17 — allow: `cancelSwap()` on the wrapper clears the gate. Unlike stock Milkman (whose
    ///         cancelSwap targets the unknowable per-order clone), the wrapper's no-arg cancel is a
    ///         first-class Safe-routed call. (Inner call reverts NoPendingOrder — swallowed by
    ///         shouldRevert=false; only the gate decision is asserted.)
    function test_WF17_CancelSwapAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                address(wrapper), 0, abi.encodeWithSignature("cancelSwap()"), CALL, ROLE_KEY, false
            );
    }

    // ==================== Helpers ====================

    function _expectReject(address to, bytes memory data) internal {
        expectPolicyReject(modAddr, ALICE, to, data, CALL, ROLE_KEY);
    }

    /// @dev Assert an openSwap clears the policy gate. `shouldRevert=false` so the wrapper's inner
    ///      execution may fail (no funds on the fork Safe) without masking the gate decision.
    function _openSwapAllowed(address fromToken, address toToken, bytes memory priceCheckerData) internal {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                address(wrapper),
                0,
                _openSwap(fromToken, toToken, PRICE_CHECKER, priceCheckerData),
                CALL,
                ROLE_KEY,
                false
            );
    }

    /// @dev DynamicSlippageChecker priceCheckerData: abi.encode(slippageBps, innerData).
    function _pcd(uint256 slippageBps, bytes memory innerData) internal pure returns (bytes memory) {
        return abi.encode(slippageBps, innerData);
    }

    /// @dev The innerData the policy pins: abi.encode(address[] feeds, bool[] reverses) for the
    ///      USDC/USD → dest/USD path (reverses [false, true]).
    function _inner(address fromFeed, address toFeed) internal pure returns (bytes memory) {
        address[] memory feeds = new address[](2);
        feeds[0] = fromFeed;
        feeds[1] = toFeed;
        bool[] memory reverses = new bool[](2);
        reverses[0] = false;
        reverses[1] = true;
        return abi.encode(feeds, reverses);
    }

    function _innerPyusd() internal pure returns (bytes memory) {
        return _inner(USDC_USD, PYUSD_USD);
    }

    function _innerRlusd() internal pure returns (bytes memory) {
        return _inner(USDC_USD, RLUSD_USD);
    }

    function _approveCd(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    /// @dev wrapper.openSwap calldata with a fixed amountIn, empty appData, and a dummy
    ///      expectedCloneAddress (the param is `pass` at the policy layer).
    function _openSwap(address fromToken, address toToken, address priceChecker, bytes memory priceCheckerData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature(
            "openSwap(uint256,address,address,bytes32,address,bytes,address)",
            AMOUNT,
            fromToken,
            toToken,
            bytes32(0),
            priceChecker,
            priceCheckerData,
            address(0)
        );
    }
}
