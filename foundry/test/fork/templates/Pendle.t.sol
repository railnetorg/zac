// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

/// @dev Minimal ERC20 surface used by the assertions.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

// --- Pendle V3 Router structs (subset; field order/types must match so the
//     interface below computes the canonical function selectors). Enums are
//     encoded as uint8.
struct SwapData {
    uint8 swapType;
    address extRouter;
    bytes extCalldata;
    bool needScale;
}

struct TokenInput {
    address tokenIn;
    uint256 netTokenIn;
    address tokenMintSy;
    address pendleSwap;
    SwapData swapData;
}

struct TokenOutput {
    address tokenOut;
    uint256 minTokenOut;
    address tokenRedeemSy;
    address pendleSwap;
    SwapData swapData;
}

struct ApproxParams {
    uint256 guessMin;
    uint256 guessMax;
    uint256 guessOffchain;
    uint256 maxIteration;
    uint256 eps;
}

struct Order {
    uint256 salt;
    uint256 expiry;
    uint256 nonce;
    uint8 orderType;
    address token;
    address YT;
    address maker;
    address receiver;
    uint256 makingAmount;
    uint256 lnImpliedRate;
    uint256 failSafeRate;
    bytes permit;
}

struct FillOrderParams {
    Order order;
    bytes signature;
    uint256 makingAmount;
}

struct LimitOrderData {
    address limitRouter;
    uint256 epsSkipMarket;
    FillOrderParams[] normalFills;
    FillOrderParams[] flashFills;
    bytes optData;
}

interface IPendleRouter {
    function swapExactTokenForPt(
        address receiver,
        address market,
        uint256 minPtOut,
        ApproxParams calldata guessPtOut,
        TokenInput calldata input,
        LimitOrderData calldata limit
    ) external returns (uint256, uint256, uint256);

    function swapExactPtForToken(
        address receiver,
        address market,
        uint256 exactPtIn,
        TokenOutput calldata output,
        LimitOrderData calldata limit
    ) external returns (uint256, uint256, uint256);

    function redeemPyToToken(address receiver, address YT, uint256 netPyIn, TokenOutput calldata output)
        external
        returns (uint256, uint256);
}

/// @title  PendleRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/pendle/pendle.tmpl` policy.
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `pendle.zac.yaml` fixture (two markets: PT-sUSDe and
///         PT-sUSDS) against the fresh Modifier. `MAINNET_RPC_URL` must be set.
///
///         "Allow" tests use `shouldRevert=false`: a policy-gate rejection reverts
///         regardless, so a clean return proves the call was authorised. The inner
///         Pendle call may fail (the Safe holds no tokens / no approval) — irrelevant
///         to the gate decision under test.
contract PendleRoleMainnetTest is ZacForkTest {
    address constant ROUTER = 0x888888888889758F76e7103c6CbF23ABbF58F946;

    // Fixture market #1 — PT-sUSDe (Ethena), maturity 2026-08-13.
    address constant SUSDE_MARKET = 0x177768caf9D0e036725A51D3f60d7E20F2D4D194;
    address constant SUSDE_PT = 0x5A19fa369F2895dCD8d2cEE62E4Ceae58eF92BBb;
    address constant SUSDE_YT = 0x45A699A11A4a17fe0931EF3ceA4BFc3235e659F2;
    address constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497; // underlying

    // Fixture market #2 — PT-sUSDS (Sky), maturity 2026-11-26.
    address constant SUSDS_MARKET = 0x9C560eBaF78e596cbcC27411d633a74D628dd7dC;
    address constant SUSDS = 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD; // underlying

    // Off-policy values.
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // not a listed underlying
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    uint8 constant CALL = 0;
    uint256 constant AMOUNT = 1_000e18;

    /// @dev `encodeKey('STRATEGY_MANAGER')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = bytes32("STRATEGY_MANAGER");

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "pendle.zac.yaml");
    }

    // ==================== approve: spender == router ====================

    /// TF-1 — allow: approve the underlying (sUSDe) to the router; allowance is set.
    function test_TF1_ApproveUnderlyingAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(SUSDE, 0, _approveCd(ROUTER, AMOUNT), CALL, ROLE_KEY, true);
        assertEq(IERC20(SUSDE).allowance(safeAddr, ROUTER), AMOUNT, "underlying allowance not set");
    }

    /// TF-2 — allow: approve the PT to the router (needed to sell / redeem).
    function test_TF2_ApprovePtAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(SUSDE_PT, 0, _approveCd(ROUTER, AMOUNT), CALL, ROLE_KEY, true);
        assertEq(IERC20(SUSDE_PT).allowance(safeAddr, ROUTER), AMOUNT, "PT allowance not set");
    }

    /// TF-3 — deny: approving any spender other than the router breaches `equal_to`.
    function test_TF3_ApproveWrongSpenderRejected() public {
        _expectReject(SUSDE, _approveCd(DEAD, AMOUNT));
    }

    // ==================== swapExactTokenForPt (entry) ====================

    /// TF-4 — allow: buy PT-sUSDe from its underlying, receiver = Safe, no aggregator.
    function test_TF4_BuyPtSusdeAllowed() public {
        _allow(_buyPt(safeAddr, SUSDE_MARKET, SUSDE, address(0)));
    }

    /// TF-5 — allow: the second configured market (PT-sUSDS) is covered by its own branch.
    function test_TF5_BuyPtSusdsAllowed() public {
        _allow(_buyPt(safeAddr, SUSDS_MARKET, SUSDS, address(0)));
    }

    /// TF-6 — deny: an unlisted market is covered by no branch.
    function test_TF6_BuyPtUnlistedMarketRejected() public {
        _expectReject(ROUTER, _buyPt(safeAddr, DEAD, SUSDE, address(0)));
    }

    /// TF-7 — deny: receiver must be the Safe (avatar) in every branch.
    function test_TF7_BuyPtForeignReceiverRejected() public {
        _expectReject(ROUTER, _buyPt(ALICE, SUSDE_MARKET, SUSDE, address(0)));
    }

    /// TF-8 — deny: a non-zero `pendleSwap` (internal aggregator) breaches `equal_to(0)`.
    function test_TF8_BuyPtWithAggregatorRejected() public {
        _expectReject(ROUTER, _buyPt(safeAddr, SUSDE_MARKET, SUSDE, DEAD));
    }

    /// TF-9 — deny: tokenIn is correlated to the market; sUSDe market + USDC tokenIn matches no branch.
    function test_TF9_BuyPtWrongTokenInRejected() public {
        _expectReject(ROUTER, _buyPt(safeAddr, SUSDE_MARKET, USDC, address(0)));
    }

    // ==================== swapExactPtForToken (early exit) ====================

    /// TF-10 — allow: sell PT-sUSDe back to its underlying, receiver = Safe, no aggregator.
    function test_TF10_SellPtSusdeAllowed() public {
        _allow(_sellPt(safeAddr, SUSDE_MARKET, SUSDE, address(0)));
    }

    /// TF-11 — deny: a non-zero `pendleSwap` on the exit leg is rejected.
    function test_TF11_SellPtWithAggregatorRejected() public {
        _expectReject(ROUTER, _sellPt(safeAddr, SUSDE_MARKET, SUSDE, DEAD));
    }

    // ==================== redeemPyToToken (maturity) ====================

    /// TF-12 — allow: redeem PT-sUSDe (by its YT) to the underlying at maturity.
    function test_TF12_RedeemSusdeAllowed() public {
        _allow(_redeem(safeAddr, SUSDE_YT, SUSDE, address(0)));
    }

    /// TF-13 — deny: an unlisted YT is covered by no branch.
    function test_TF13_RedeemWrongYtRejected() public {
        _expectReject(ROUTER, _redeem(safeAddr, DEAD, SUSDE, address(0)));
    }

    /// TF-14 — deny: receiver must be the Safe (avatar).
    function test_TF14_RedeemForeignReceiverRejected() public {
        _expectReject(ROUTER, _redeem(ALICE, SUSDE_YT, SUSDE, address(0)));
    }

    // ==================== Helpers ====================

    /// @dev Assert a call clears the policy gate. `shouldRevert=false` so the inner Pendle
    ///      execution may fail without masking the gate decision; a clean return proves the
    ///      call was authorised.
    function _allow(bytes memory data) internal {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(ROUTER, 0, data, CALL, ROLE_KEY, false);
    }

    function _expectReject(address to, bytes memory data) internal {
        expectPolicyReject(modAddr, ALICE, to, data, CALL, ROLE_KEY);
    }

    function _approveCd(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    function _approx() internal pure returns (ApproxParams memory) {
        return ApproxParams({guessMin: 0, guessMax: type(uint256).max, guessOffchain: 0, maxIteration: 256, eps: 1e14});
    }

    /// @dev Empty LimitOrderData (no limit orders) — `createEmptyLimitOrderData` equivalent.
    function _limit() internal pure returns (LimitOrderData memory l) {
        l.normalFills = new FillOrderParams[](0);
        l.flashFills = new FillOrderParams[](0);
    }

    /// @dev TokenInput pinning tokenIn == tokenMintSy; swapData left empty (swapType NONE).
    function _input(address tokenIn, address pendleSwap) internal pure returns (TokenInput memory t) {
        t.tokenIn = tokenIn;
        t.netTokenIn = AMOUNT;
        t.tokenMintSy = tokenIn;
        t.pendleSwap = pendleSwap;
    }

    function _output(address tokenOut, address pendleSwap) internal pure returns (TokenOutput memory t) {
        t.tokenOut = tokenOut;
        t.tokenRedeemSy = tokenOut;
        t.pendleSwap = pendleSwap;
    }

    function _buyPt(address receiver, address market, address tokenIn, address pendleSwap)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.swapExactTokenForPt, (receiver, market, 0, _approx(), _input(tokenIn, pendleSwap), _limit())
        );
    }

    function _sellPt(address receiver, address market, address tokenOut, address pendleSwap)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            IPendleRouter.swapExactPtForToken, (receiver, market, AMOUNT, _output(tokenOut, pendleSwap), _limit())
        );
    }

    function _redeem(address receiver, address yt, address tokenOut, address pendleSwap)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IPendleRouter.redeemPyToToken, (receiver, yt, AMOUNT, _output(tokenOut, pendleSwap)));
    }
}
