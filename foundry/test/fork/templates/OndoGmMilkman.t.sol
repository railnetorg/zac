// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

/// @dev Minimal ERC20 surface used by the assertions.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @dev The Chainlink DynamicSlippageChecker's expected-out calculator. The checker
///      splits priceCheckerData into (uint256 slippageBps, bytes innerData) and calls
///      this with innerData; it reads each feed via latestAnswer() + decimals().
interface IExpectedOutCalculator {
    function getExpectedOut(uint256 amountIn, address fromToken, address toToken, bytes calldata data)
        external
        view
        returns (uint256);
}

/// @title  OndoGmMilkmanRoleMainnetTest
/// @notice Mainnet-fork acceptance test for `templates/milkman/milkman.tmpl` applied to
///         an Ondo Global Markets token: a bidirectional USDC ↔ SPYon round-trip.
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies `ondo_gm_milkman.zac.yaml` (test/fork/templates/test_config/).
///         `MAINNET_RPC_URL` must be set.
///
///         The fixture lists USDC and SPYon in BOTH from_tokens and to_tokens. The
///         template's swap allow-list is the cartesian from_tokens × to_tokens with
///         self-pairs (from == to.token) dropped by the `milkman_pairs` filter, so the
///         function root is an `or` of exactly two branches:
///           USDC  → SPYon  (buy,  slippage ≤ 300 bps)
///           SPYon → USDC   (sell, slippage ≤ 200 bps)
///         The dropped USDC→USDC / SPYon→SPYon self-pairs are asserted to be un-routable
///         (GF-9/GF-10) — the regression guard for the cartesian fix.
///
///         Each branch pins (fromToken, toToken, to=avatar, priceChecker) and bounds the
///         swap's priceCheckerData: slippageBps is capped per pair, and innerData
///         (abi.encode(address[] feeds, bool[] reverses)) is pinned to the exact price
///         path — so the cap is measured against a fixed oracle, not one the caller picks.
///
///         GM-specific de-risk (GF-18): unlike the stablecoin milkman policy — whose note
///         warns that raw Chainlink aggregators block the calculator's read — the Ondo GM
///         "Calculated" feed IS consumable by the production DynamicSlippageChecker
///         calculator. GF-18 proves it end-to-end: getExpectedOut over the pinned
///         [USDC/USD, SPYon-USD] path returns a sane SPYon amount, so the slippage gate is
///         functional for GM swaps. (A live CoW solver fill cannot be exercised on a fork;
///         that depends on KYB-gated GM liquidity and is verified separately on mainnet.)
///
///         Swap "allow" tests use `shouldRevert=false`: the policy gate is the only
///         assertion. Milkman's inner logic may fail on the fork, but a gate rejection
///         would revert regardless, so a clean return proves the policy authorised the call.
contract OndoGmMilkmanRoleMainnetTest is ZacForkTest {
    // Mainnet protocol addresses referenced by the policy + assertions.
    address constant MILKMAN = 0x060373D064d0168931dE2AB8DDA7410923d06E88;
    address constant PRICE_CHECKER = 0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c;
    // The DynamicSlippageChecker's ChainlinkExpectedOutCalculator (reads latestAnswer()).
    address constant CALCULATOR = 0xe23fc134382de3eAF871C249C90bf3Acb846C5ab;

    // Policy tokens (bidirectional round-trip).
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // from ✓ / to ✓
    address constant SPYon = 0xFeDC5f4a6c38211c1338aa411018DFAf26612c08; // from ✓ / to ✓ (Ondo GM, 18-dec)

    // Off-policy tokens (no branch covers them).
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // fromToken ✗
    address constant QQQon = 0x0e397938C1Aa0680954093495B70A9F5e2249aBa; // toToken   ✗ (another GM token)

    // Feeds the policy pins (reverses [false, true]). USDC via the Aave capped adapter;
    // SPYon via the Ondo GM Chainlink "Calculated" feed (no capped adapter exists).
    address constant USDC_USD = 0x3f73F03aa83B2A48ed27E964eD0fDb590332095B;
    address constant SPY_USD = 0xd16cC387E87d37350f57421DaDF811968441C1a5;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant NOT_MILKMAN = 0x000000000000000000000000000000000000dEaD;
    address constant WRONG_CHECKER = 0x000000000000000000000000000000000000bEEF;
    address constant ATTACKER_FEED = 0x000000000000000000000000000000000000FEeD;
    uint8 constant CALL = 0;
    uint256 constant AMOUNT_USDC = 1_000e6; // 1000 USDC
    uint256 constant AMOUNT_SPY = 1e18; // 1 SPYon

    // Per-pair slippage caps (from the fixture).
    uint256 constant BUY_CAP = 300; // USDC → SPYon
    uint256 constant SELL_CAP = 200; // SPYon → USDC

    /// @dev `encodeKey('STRATEGY_MANAGER')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x53545241544547595f4d414e4147455200000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "ondo_gm_milkman.zac.yaml");
    }

    // ==================== approve: spender == Milkman, amount < uint256.max ====================

    /// GF-1 — allow: approve USDC to Milkman (USDC is a from-token).
    function test_GF1_ApproveUsdcAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(USDC, 0, _approveCd(MILKMAN, AMOUNT_USDC), CALL, ROLE_KEY, true);
        assertEq(IERC20(USDC).allowance(safeAddr, MILKMAN), AMOUNT_USDC, "USDC allowance not set");
    }

    /// GF-2 — allow: approve SPYon to Milkman. SPYon is a from-token (the sell leg), so
    ///        approve is scoped on it too — the bidirectional config approves both sides.
    function test_GF2_ApproveSpyonAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(SPYon, 0, _approveCd(MILKMAN, AMOUNT_SPY), CALL, ROLE_KEY, true);
        assertEq(IERC20(SPYon).allowance(safeAddr, MILKMAN), AMOUNT_SPY, "SPYon allowance not set");
    }

    /// GF-3 — deny: infinite approval breaches the `less_than uint256.max` cap.
    function test_GF3_ApproveUnlimitedRejected() public {
        _expectReject(USDC, _approveCd(MILKMAN, type(uint256).max));
    }

    /// GF-4 — deny: approving any spender other than Milkman breaches `equal_to`.
    function test_GF4_ApproveWrongSpenderRejected() public {
        _expectReject(USDC, _approveCd(NOT_MILKMAN, AMOUNT_USDC));
    }

    /// GF-5 — deny: approve is scoped to the two from-tokens only; USDT is not listed.
    function test_GF5_ApproveUnlistedTokenRejected() public {
        _expectReject(USDT, _approveCd(MILKMAN, AMOUNT_USDC));
    }

    // ==================== requestSwap: the two round-trip branches ====================

    /// GF-6 — allow: buy USDC → SPYon at 250 bps, within the 300 bps cap, pinned feeds.
    function test_GF6_BuyWithinCapAllowed() public {
        _swapAllowed(USDC, SPYon, _pcd(250, _innerBuy()));
    }

    /// GF-7 — allow: sell SPYon → USDC at 150 bps, within the 200 bps cap — the other
    ///        leg of the round-trip.
    function test_GF7_SellWithinCapAllowed() public {
        _swapAllowed(SPYon, USDC, _pcd(150, _innerSell()));
    }

    /// GF-8 — allow: buy exactly at the cap (300 bps) clears `less_than 301`. Boundary.
    function test_GF8_BuyAtCapAllowed() public {
        _swapAllowed(USDC, SPYon, _pcd(BUY_CAP, _innerBuy()));
    }

    /// GF-9 — deny: buy at 301 bps exceeds the 300 bps cap (`less_than 301`).
    function test_GF9_BuyOverCapRejected() public {
        _expectReject(MILKMAN, _swap(USDC, SPYon, safeAddr, PRICE_CHECKER, _pcd(BUY_CAP + 1, _innerBuy())));
    }

    /// GF-10 — deny: sell at 201 bps exceeds the 200 bps cap. Each leg's own cap is enforced.
    function test_GF10_SellOverCapRejected() public {
        _expectReject(MILKMAN, _swap(SPYon, USDC, safeAddr, PRICE_CHECKER, _pcd(SELL_CAP + 1, _innerSell())));
    }

    /// GF-11 — deny: sell SPYon → USDC at 250 bps. 250 clears the BUY cap (300) but not the
    ///         SELL cap (200): the cap is correlated to the exact pair, so neither branch
    ///         matches. The per-pair guarantee the `or` provides.
    function test_GF11_SellWithBuyCapRejected() public {
        _expectReject(MILKMAN, _swap(SPYon, USDC, safeAddr, PRICE_CHECKER, _pcd(250, _innerSell())));
    }

    // ==================== self-pairs are dropped from the cartesian ====================

    /// GF-12 — deny: USDC → USDC. The self-pair was dropped by `milkman_pairs`, so no
    ///         branch routes it. Regression guard for the cartesian fix.
    function test_GF12_SelfPairUsdcRejected() public {
        _expectReject(MILKMAN, _swap(USDC, USDC, safeAddr, PRICE_CHECKER, _pcd(100, _innerBuy())));
    }

    /// GF-13 — deny: SPYon → SPYon. The other dropped self-pair.
    function test_GF13_SelfPairSpyonRejected() public {
        _expectReject(MILKMAN, _swap(SPYon, SPYon, safeAddr, PRICE_CHECKER, _pcd(100, _innerSell())));
    }

    // ==================== scope + pin boundaries ====================

    /// GF-14 — deny: toToken not covered by any branch (another GM token, QQQon).
    function test_GF14_SwapToUnlistedTokenRejected() public {
        _expectReject(MILKMAN, _swap(USDC, QQQon, safeAddr, PRICE_CHECKER, _pcd(100, _innerBuy())));
    }

    /// GF-15 — deny: fromToken not covered by any branch (USDT).
    function test_GF15_SwapFromUnlistedTokenRejected() public {
        _expectReject(MILKMAN, _swap(USDT, SPYon, safeAddr, PRICE_CHECKER, _pcd(100, _innerBuy())));
    }

    /// GF-16 — deny: receiver must be the Safe (avatar) in every branch.
    function test_GF16_SwapToForeignReceiverRejected() public {
        _expectReject(MILKMAN, _swap(USDC, SPYon, ALICE, PRICE_CHECKER, _pcd(100, _innerBuy())));
    }

    /// GF-17 — deny: priceChecker is pinned; a substitute is rejected.
    function test_GF17_SwapWrongPriceCheckerRejected() public {
        _expectReject(MILKMAN, _swap(USDC, SPYon, safeAddr, WRONG_CHECKER, _pcd(100, _innerBuy())));
    }

    /// GF-18 — deny: innerData is pinned to the pair's exact price path. A within-cap swap
    ///         with an attacker-chosen "feed" (the ≈0 fair-price drain vector) is rejected;
    ///         only the pinned USDC/USD → SPYon-USD path clears the gate.
    function test_GF18_SwapAttackerFeedRejected() public {
        bytes memory pcd = _pcd(100, _inner(USDC_USD, ATTACKER_FEED));
        _expectReject(MILKMAN, _swap(USDC, SPYon, safeAddr, PRICE_CHECKER, pcd));
    }

    /// GF-19 — deny: feeds are bound to the exact pair/direction. A buy (USDC → SPYon) that
    ///         supplies the SELL leg's feed order is rejected: the buy branch wants the buy
    ///         feeds, and the sell branch wants toToken == USDC — neither matches.
    function test_GF19_SwapMismatchedDirectionFeedsRejected() public {
        _expectReject(MILKMAN, _swap(USDC, SPYon, safeAddr, PRICE_CHECKER, _pcd(100, _innerSell())));
    }

    /// GF-20 — deny: only requestSwap is scoped on Milkman; cancelSwap (a different selector)
    ///         is not authorised — cancellations go through the Safe UI (see template note).
    function test_GF20_CancelSwapRejected() public {
        bytes memory cancelCd = abi.encodeWithSignature(
            "cancelSwap(uint256,address,address,address,bytes32,address,bytes)",
            AMOUNT_USDC,
            USDC,
            SPYon,
            safeAddr,
            bytes32(0),
            PRICE_CHECKER,
            _pcd(100, _innerBuy())
        );
        _expectReject(MILKMAN, cancelCd);
    }

    // ==================== GM de-risk: the price checker can read the GM feed ====================

    /// GF-21 — the production DynamicSlippageChecker calculator prices both legs of the
    ///         round-trip through the pinned GM Calculated feed. This is the M4 de-risk:
    ///         the raw-aggregator read-blocking that the stablecoin policy warns about does
    ///         NOT apply to the Ondo GM feed, so the slippage gate is functional for GM
    ///         swaps. Bands are wide to tolerate live price drift while still catching a
    ///         decimal-scale (1e8 vs 1e18) regression.
    function test_GF21_CalculatorReadsGmFeed() public view {
        // Buy: 1000 USDC → SPYon. SPYon ≈ $100–$2000 ⇒ 0.5–10 SPYon (18-dec).
        uint256 outSpy = IExpectedOutCalculator(CALCULATOR).getExpectedOut(AMOUNT_USDC, USDC, SPYon, _innerBuy());
        assertGt(outSpy, 1e17, "buy: expectedOut too low (feed unreadable or mis-scaled)");
        assertLt(outSpy, 100e18, "buy: expectedOut too high (decimal regression)");

        // Sell: 1 SPYon → USDC. 1 SPYon ≈ $100–$2000 (6-dec USDC).
        uint256 outUsdc = IExpectedOutCalculator(CALCULATOR).getExpectedOut(AMOUNT_SPY, SPYon, USDC, _innerSell());
        assertGt(outUsdc, 50e6, "sell: expectedOut too low (feed unreadable or mis-scaled)");
        assertLt(outUsdc, 5_000e6, "sell: expectedOut too high (decimal regression)");
    }

    // ==================== Helpers ====================

    /// @dev Assert `ALICE`'s `execTransactionWithRole(to, 0, data, CALL)` is rejected at the
    ///      policy gate (reverts with `ConditionViolation`).
    function _expectReject(address to, bytes memory data) internal {
        expectPolicyReject(modAddr, ALICE, to, data, CALL, ROLE_KEY);
    }

    /// @dev Assert a swap clears the policy gate. `shouldRevert=false` so Milkman's inner
    ///      execution may fail without masking the gate decision; a gate rejection would
    ///      revert regardless, so a clean return proves the call was authorised.
    function _swapAllowed(address fromToken, address toToken, bytes memory priceCheckerData) internal {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(
            MILKMAN, 0, _swap(fromToken, toToken, safeAddr, PRICE_CHECKER, priceCheckerData), CALL, ROLE_KEY, false
        );
    }

    /// @dev Chainlink DynamicSlippageChecker priceCheckerData: abi.encode(slippageBps, innerData).
    function _pcd(uint256 slippageBps, bytes memory innerData) internal pure returns (bytes memory) {
        return abi.encode(slippageBps, innerData);
    }

    /// @dev innerData: abi.encode(address[] feeds, bool[] reverses), reverses [false, true].
    function _inner(address fromFeed, address toFeed) internal pure returns (bytes memory) {
        address[] memory feeds = new address[](2);
        feeds[0] = fromFeed;
        feeds[1] = toFeed;
        bool[] memory reverses = new bool[](2);
        reverses[0] = false;
        reverses[1] = true;
        return abi.encode(feeds, reverses);
    }

    /// @dev Buy leg USDC → SPYon: price path [USDC/USD, SPYon-USD].
    function _innerBuy() internal pure returns (bytes memory) {
        return _inner(USDC_USD, SPY_USD);
    }

    /// @dev Sell leg SPYon → USDC: price path [SPYon-USD, USDC/USD].
    function _innerSell() internal pure returns (bytes memory) {
        return _inner(SPY_USD, USDC_USD);
    }

    function _approveCd(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    /// @dev requestSwap calldata with a fixed amountIn and empty appData.
    function _swap(address fromToken, address toToken, address to, address priceChecker, bytes memory priceCheckerData)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature(
            "requestSwapExactTokensForTokens(uint256,address,address,address,bytes32,address,bytes)",
            AMOUNT_USDC,
            fromToken,
            toToken,
            to,
            bytes32(0),
            priceChecker,
            priceCheckerData
        );
    }
}
