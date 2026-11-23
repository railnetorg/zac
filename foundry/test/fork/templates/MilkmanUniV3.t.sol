// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

/// @dev Minimal ERC20 surface used by the assertions.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @dev The deployed UniV3 DynamicSlippageChecker + its expected-out calculator,
///      called directly (not through the role) by the integration tests to prove
///      the policy's pinned innerData is exactly what the checker decodes.
interface IPriceChecker {
    function EXPECTED_OUT_CALCULATOR() external view returns (address);
    function checkPrice(
        uint256 amountIn,
        address fromToken,
        address toToken,
        uint256 feeAmount,
        uint256 minOut,
        bytes calldata data
    ) external view returns (bool);
}

interface IExpectedOutCalculator {
    function getExpectedOut(uint256 amountIn, address fromToken, address toToken, bytes calldata data)
        external
        view
        returns (uint256);
}

/// @title  MilkmanUniV3RoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/milkman/milkman_univ3.tmpl`
///         policy — the UniV3-quoted variant of the Milkman template, for tokens
///         with no usable Chainlink feed (born from selling PENDLE rewards).
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `milkman_univ3.zac.yaml` fixture
///         (test/fork/templates/test_config/). `MAINNET_RPC_URL` must be set.
///
///         The fixture configures two swaps with distinct caps and routes:
///           PENDLE → wstETH, priced via [PENDLE, WETH, wstETH] fees [30, 1] bips,
///                    slippage ≤ 200 bps
///           WETH   → USDC,   priced via [WETH, USDC] fees [5] bips,
///                    slippage ≤ 100 bps
///         so the function root is an `or` of two branches. Each branch pins
///         (fromToken, toToken, to=avatar, priceChecker) and bounds the swap's
///         priceCheckerData, which the DynamicSlippageChecker ABI-encodes as
///         (uint256 slippageBps, bytes innerData): slippageBps is capped per swap,
///         and innerData (the abi.encode(address[] swapPath, uint24[] poolFees)
///         pool route) is pinned — so the cap is measured against a fixed route,
///         not one the caller chooses.
///
///         Swap "allow" tests use `shouldRevert=false`: the policy gate is the only
///         assertion (see Milkman.t.sol for the rationale). On top of the gate
///         tests, TU-20/21 call the DEPLOYED checker directly with the exact blob
///         the policy pins and assert the slippage math around the boundary — this
///         proves the (address[], uint24[]) layout and the bips fee units are what
///         the checker's calculator actually decodes and quotes (a wrong fee unit
///         would point at a nonexistent pool and revert the quoter).
contract MilkmanUniV3RoleMainnetTest is ZacForkTest {
    // Mainnet protocol addresses referenced by the policy + assertions.
    address constant MILKMAN = 0x060373D064d0168931dE2AB8DDA7410923d06E88;
    address constant UNIV3_CHECKER = 0x2F965935f93718bB66d53a37a97080785657f0AC;
    address constant UNIV3_CALCULATOR = 0xEb80C478f72ac353736be8954eE1aD1B167551F9;
    // The Chainlink DynamicSlippageChecker pinned by milkman.tmpl — used here as
    // the "wrong checker": the two template variants must not cross-authorise.
    address constant CHAINLINK_CHECKER = 0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c;

    // Fixture swap 1: PENDLE → wstETH via [PENDLE, WETH, wstETH], fees [30, 1], cap 200.
    address constant PENDLE = 0x808507121B80c02388fAd14726482e061B8da827;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    // Fixture swap 2: WETH → USDC via [WETH, USDC], fees [5], cap 100.
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant NOT_MILKMAN = 0x000000000000000000000000000000000000dEaD;
    address constant ATTACKER_TOKEN = 0x000000000000000000000000000000000000bAaD;
    uint8 constant CALL = 0;
    uint256 constant PENDLE_AMOUNT = 2_000e18;
    uint256 constant WETH_AMOUNT = 10e18;

    /// @dev `encodeKey('STRATEGY_MANAGER')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x53545241544547595f4d414e4147455200000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "milkman_univ3.zac.yaml");
    }

    // ==================== approve: spender == Milkman, amount < uint256.max ====================

    /// TU-1 — allow: approve PENDLE to Milkman for a normal amount; allowance is set.
    function test_TU1_ApprovePendleToMilkmanAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(PENDLE, 0, _approveCd(MILKMAN, PENDLE_AMOUNT), CALL, ROLE_KEY, true);
        assertEq(IERC20(PENDLE).allowance(safeAddr, MILKMAN), PENDLE_AMOUNT, "allowance not set");
    }

    /// TU-2 — allow: WETH is the second swap's from-token; its approve is scoped too.
    function test_TU2_ApproveWethToMilkmanAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(WETH, 0, _approveCd(MILKMAN, WETH_AMOUNT), CALL, ROLE_KEY, true);
        assertEq(IERC20(WETH).allowance(safeAddr, MILKMAN), WETH_AMOUNT, "allowance not set");
    }

    /// TU-3 — deny: amount == uint256.max (infinite approval) breaches the `less_than` cap.
    function test_TU3_ApproveUnlimitedRejected() public {
        _expectReject(PENDLE, _approveCd(MILKMAN, type(uint256).max));
    }

    /// TU-4 — deny: approving any spender other than Milkman breaches `equal_to`.
    function test_TU4_ApproveWrongSpenderRejected() public {
        _expectReject(PENDLE, _approveCd(NOT_MILKMAN, PENDLE_AMOUNT));
    }

    /// TU-5 — deny: approve is scoped on from-tokens only. wstETH is a destination
    ///        (and USDC too) — approving it to Milkman hits no permission.
    function test_TU5_ApproveUnlistedTokenRejected() public {
        _expectReject(WSTETH, _approveCd(MILKMAN, PENDLE_AMOUNT));
    }

    // ==================== requestSwap: per-swap branch + slippage cap ====================

    /// TU-6 — allow: PENDLE → wstETH at 150 bps, within the 200 bps cap, with the
    ///        pinned pool route.
    function test_TU6_SwapPendleWithinCapAllowed() public {
        _swapAllowed(PENDLE_AMOUNT, PENDLE, WSTETH, _pcd(150, _innerPendle()));
    }

    /// TU-7 — allow: slippage exactly at the cap (200 bps) clears `less_than 201`.
    function test_TU7_SwapPendleAtCapAllowed() public {
        _swapAllowed(PENDLE_AMOUNT, PENDLE, WSTETH, _pcd(200, _innerPendle()));
    }

    /// TU-8 — deny: PENDLE → wstETH at 201 bps exceeds the 200 bps cap.
    function test_TU8_SwapPendleOverCapRejected() public {
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WSTETH, safeAddr, UNIV3_CHECKER, _pcd(201, _innerPendle())));
    }

    /// TU-9 — allow: WETH → USDC at its own 100 bps cap boundary.
    function test_TU9_SwapWethAtCapAllowed() public {
        _swapAllowed(WETH_AMOUNT, WETH, USDC, _pcd(100, _innerWeth()));
    }

    /// TU-10 — deny: WETH → USDC at 150 bps. 150 is fine for the PENDLE branch
    ///         (cap 200) but not for WETH → USDC (cap 100): the cap is correlated
    ///         to the exact swap, so neither branch matches.
    function test_TU10_SwapWethWithPendleCapRejected() public {
        _expectReject(MILKMAN, _swap(WETH_AMOUNT, WETH, USDC, safeAddr, UNIV3_CHECKER, _pcd(150, _innerWeth())));
    }

    /// TU-11 — deny: WETH is an intermediate pricing hop of swap 1, not a listed
    ///         destination for PENDLE. Path tokens grant nothing beyond (from, to).
    function test_TU11_SwapPendleToIntermediateRejected() public {
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WETH, safeAddr, UNIV3_CHECKER, _pcd(150, _innerPendle())));
    }

    /// TU-12 — deny: fromToken wstETH is covered by no branch.
    function test_TU12_SwapFromUnlistedTokenRejected() public {
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, WSTETH, WETH, safeAddr, UNIV3_CHECKER, _pcd(150, _innerPendle())));
    }

    /// TU-13 — deny: receiver must be the Safe (avatar) in every branch.
    function test_TU13_SwapToForeignReceiverRejected() public {
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WSTETH, ALICE, UNIV3_CHECKER, _pcd(150, _innerPendle())));
    }

    /// TU-14 — deny: priceChecker is pinned to the UniV3 checker; the CHAINLINK
    ///         DynamicSlippageChecker (the one milkman.tmpl pins) is rejected here —
    ///         the two template variants do not cross-authorise.
    function test_TU14_SwapChainlinkCheckerRejected() public {
        _expectReject(
            MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WSTETH, safeAddr, CHAINLINK_CHECKER, _pcd(150, _innerPendle()))
        );
    }

    /// TU-15 — deny: innerData (the pool route after slippageBps) is pinned; a
    ///         within-cap swap with an arbitrary blob is rejected.
    function test_TU15_SwapFreeInnerDataRejected() public {
        bytes memory pcd = abi.encode(uint256(150), abi.encode("arbitrary route"));
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WSTETH, safeAddr, UNIV3_CHECKER, pcd));
    }

    /// TU-16 — deny: same route, different fee tier ([30, 5] instead of [30, 1]) is
    ///         a different pinned blob — rejected. The cap is measured against the
    ///         exact pools the policy chose, not any pool for the pair.
    function test_TU16_SwapWrongFeeTierRejected() public {
        uint24[] memory fees = new uint24[](2);
        fees[0] = 30;
        fees[1] = 5;
        bytes memory pcd = _pcd(150, abi.encode(_pendlePath(), fees));
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WSTETH, safeAddr, UNIV3_CHECKER, pcd));
    }

    /// TU-17 — deny: a structurally valid route through an attacker-chosen middle
    ///         token (the ≈0 expected-out drain vector) is rejected within cap. Only
    ///         the pinned [PENDLE, WETH, wstETH] route clears the gate, so the
    ///         slippage bound is measured against pools the member cannot swap out.
    function test_TU17_SwapAttackerRouteRejected() public {
        address[] memory path = new address[](3);
        path[0] = PENDLE;
        path[1] = ATTACKER_TOKEN;
        path[2] = WSTETH;
        uint24[] memory fees = new uint24[](2);
        fees[0] = 30;
        fees[1] = 1;
        bytes memory pcd = _pcd(150, abi.encode(path, fees));
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WSTETH, safeAddr, UNIV3_CHECKER, pcd));
    }

    /// TU-18 — deny: routes are bound to the exact swap. A PENDLE → wstETH swap
    ///         that supplies the WETH → USDC route is rejected: the PENDLE branch
    ///         wants the PENDLE route, and the WETH branch wants fromToken == WETH —
    ///         neither matches.
    function test_TU18_SwapMismatchedRouteRejected() public {
        _expectReject(MILKMAN, _swap(PENDLE_AMOUNT, PENDLE, WSTETH, safeAddr, UNIV3_CHECKER, _pcd(150, _innerWeth())));
    }

    // ==================== scope boundaries: only the two listed functions ====================

    /// TU-19 — deny: only requestSwap is scoped on Milkman. cancelSwap (a different
    ///         selector on the same target) is not authorised through the role —
    ///         cancellations go directly through the Safe UI (see the template note).
    function test_TU19_CancelSwapRejected() public {
        bytes memory cancelCd = abi.encodeWithSignature(
            "cancelSwap(uint256,address,address,address,bytes32,address,bytes)",
            PENDLE_AMOUNT,
            PENDLE,
            WSTETH,
            safeAddr,
            bytes32(0),
            UNIV3_CHECKER,
            _pcd(150, _innerPendle())
        );
        _expectReject(MILKMAN, cancelCd);
    }

    // ==================== integration: the pinned blob against the DEPLOYED checker ====================

    /// TU-20 — the checker wired to the policy is the DynamicSlippageChecker around
    ///         the UniV3 expected-out calculator (pin sanity for the alias).
    function test_TU20_CheckerWiredToUniV3Calculator() public view {
        assertEq(
            IPriceChecker(UNIV3_CHECKER).EXPECTED_OUT_CALCULATOR(), UNIV3_CALCULATOR, "checker/calculator mismatch"
        );
    }

    /// TU-21 — end-to-end pricing proof: feed the DEPLOYED checker the exact blob the
    ///         policy pins and assert the slippage boundary. This proves the pinned
    ///         (address[] swapPath, uint24[] poolFees) layout and the BIPS fee units
    ///         decode into live pools (a wrong unit would revert the quoter), and that
    ///         checkPrice enforces minOut > expectedOut × (1 − slippage).
    function test_TU21_CheckerBoundaryWithPinnedRoute() public view {
        uint256 expectedOut =
            IExpectedOutCalculator(UNIV3_CALCULATOR).getExpectedOut(PENDLE_AMOUNT, PENDLE, WSTETH, _innerPendle());
        assertGt(expectedOut, 0, "route quoted zero");

        uint256 slippageBps = 150;
        uint256 floor = expectedOut * (10_000 - slippageBps) / 10_000;

        bytes memory pcd = _pcd(slippageBps, _innerPendle());
        assertTrue(
            IPriceChecker(UNIV3_CHECKER).checkPrice(PENDLE_AMOUNT, PENDLE, WSTETH, 0, floor + 1, pcd),
            "minOut just above the floor must pass"
        );
        assertFalse(
            IPriceChecker(UNIV3_CHECKER).checkPrice(PENDLE_AMOUNT, PENDLE, WSTETH, 0, floor, pcd),
            "minOut at the floor must fail"
        );
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
    function _swapAllowed(uint256 amountIn, address fromToken, address toToken, bytes memory priceCheckerData)
        internal
    {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                MILKMAN,
                0,
                _swap(amountIn, fromToken, toToken, safeAddr, UNIV3_CHECKER, priceCheckerData),
                CALL,
                ROLE_KEY,
                false
            );
    }

    /// @dev DynamicSlippageChecker priceCheckerData: abi.encode(slippageBps, innerData).
    ///      The policy pins innerData per swap, so callers must supply the matching blob.
    function _pcd(uint256 slippageBps, bytes memory innerData) internal pure returns (bytes memory) {
        return abi.encode(slippageBps, innerData);
    }

    function _pendlePath() internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = PENDLE;
        path[1] = WETH;
        path[2] = WSTETH;
    }

    /// @dev The innerData the policy pins for swap 1: abi.encode(swapPath, poolFees)
    ///      for [PENDLE, WETH, wstETH] through the 0.3% and 0.01% pools (fees in BIPS).
    function _innerPendle() internal pure returns (bytes memory) {
        uint24[] memory fees = new uint24[](2);
        fees[0] = 30;
        fees[1] = 1;
        return abi.encode(_pendlePath(), fees);
    }

    /// @dev The innerData the policy pins for swap 2: [WETH, USDC] through the 0.05% pool.
    function _innerWeth() internal pure returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = USDC;
        uint24[] memory fees = new uint24[](1);
        fees[0] = 5;
        return abi.encode(path, fees);
    }

    function _approveCd(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    /// @dev requestSwap calldata with empty appData.
    function _swap(
        uint256 amountIn,
        address fromToken,
        address toToken,
        address to,
        address priceChecker,
        bytes memory priceCheckerData
    ) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "requestSwapExactTokensForTokens(uint256,address,address,address,bytes32,address,bytes)",
            amountIn,
            fromToken,
            toToken,
            to,
            bytes32(0),
            priceChecker,
            priceCheckerData
        );
    }
}
