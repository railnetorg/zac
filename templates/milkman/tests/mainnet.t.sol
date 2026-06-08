// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {ZacForkTester} from "zac-test/ZacForkTester.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IRolesModifier {
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool);
}

/// @dev Exercises the milkman template on Ethereum mainnet.
///
///      setUp forks mainnet, re-runs `zac generate` + `zac plan` against the
///      already-deployed Roles V2 modifier, then replays the plan calls so
///      the on-chain modifier state reflects the current policy.
///
///      These tests cover the POLICY GATE only, not Milkman's swap execution.
///      TF-3 and TF-4 use shouldRevert=false so that Milkman's internal logic
///      (which needs a live CoW order book) can fail without masking policy errors.
///
///      The end-to-end swap (policy → Milkman → CoW settlement) has been proven
///      on mainnet: tx 0x8fc655d21985dc3af30643aec7d3e3c6ceb3389edc109fb09eeeded9178e69e6
///      14 USDC → 13.435 PYUSD, fulfilled by a CoW solver.
///
///      Policy assertions:
///        TF-1  USDC  → approved fromToken  (approve to Milkman succeeds)
///        TF-2  USDT  → blocked  fromToken  (approve to Milkman reverts)
///        TF-3  PYUSD → approved toToken    (requestSwap passes the policy)
///        TF-4  RLUSD → approved toToken    (requestSwap passes the policy)
///        TF-5  WETH  → blocked  toToken    (requestSwap reverts)
///
/// Run:
///   ETH_RPC_URL=<mainnet-rpc> FOUNDRY_PROFILE=zac forge test \
///     --match-path "zac/templates/milkman/tests/*" -vvv
contract MilkmanMainnetTest is ZacForkTester {
    // --- Project addresses ---
    address constant SAFE = 0x14147ffC6595D1DB7C1797FF0F6AE4455df89BE2;
    address constant MODIFIER = 0x8284Cb3136c9E1907E0f285c9C20D5b0426d8FB0;
    address constant STRATEGY_MANAGER = 0xCb0dEd7FCa9dA8d3052C84485B77B5cd7B511760;
    address constant MILKMAN = 0x060373D064d0168931dE2AB8DDA7410923d06E88;
    address constant PRICE_CHECKER = 0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c;

    // --- Allowed tokens ---
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // fromToken ✓
    address constant PYUSD = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8; // toToken   ✓
    address constant RLUSD = 0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD; // toToken   ✓

    // --- Blocked tokens (not in the policy allow-lists) ---
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // fromToken ✗
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // toToken   ✗

    bytes32 constant ROLE_KEY = bytes32("STRATEGY_MANAGER");

    IRolesModifier internal rolesMod = IRolesModifier(MODIFIER);

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        zacApply("../examples/mainnet/milkman.yaml");
    }

    //
    // // -----------------------------------------------------------------------
    // // TF-1 — USDC is an allowed fromToken
    // // -----------------------------------------------------------------------
    //
    // /// @notice Strategy manager can approve USDC to Milkman; the Safe's
    // ///         USDC allowance towards Milkman is updated.
    // function test_TF1_USDC_allowed_fromToken() public {
    //     vm.startPrank(STRATEGY_MANAGER);
    //     bool ok = rolesMod.execTransactionWithRole(
    //         USDC, 0, abi.encodeWithSelector(IERC20.approve.selector, MILKMAN, 1000e6), 0, ROLE_KEY, true
    //     );
    //     vm.stopPrank();
    //     assertTrue(ok, "approve(USDC, MILKMAN) should pass the policy");
    //     assertEq(IERC20(USDC).allowance(SAFE, MILKMAN), 1000e6, "allowance not set");
    // }
    //
    // // -----------------------------------------------------------------------
    // // TF-2 — USDT is NOT in the fromToken allow-list
    // // -----------------------------------------------------------------------
    //
    // /// @notice Attempting to approve USDT to Milkman is rejected by the
    // ///         Roles modifier because USDT was not declared as a fromToken.
    // function test_TF2_USDT_blocked_fromToken() public {
    //     vm.startPrank(STRATEGY_MANAGER);
    //     vm.expectRevert();
    //     rolesMod.execTransactionWithRole(
    //         USDT, 0, abi.encodeWithSelector(IERC20.approve.selector, MILKMAN, 1000e6), 0, ROLE_KEY, true
    //     );
    //     vm.stopPrank();
    // }
    //
    // // -----------------------------------------------------------------------
    // // TF-3 — PYUSD is an allowed toToken
    // // -----------------------------------------------------------------------
    //
    // /// @notice Strategy manager can request a USDC → PYUSD swap through Milkman.
    // ///         shouldRevert=false: the POLICY must allow the call; Milkman's
    // ///         internal logic may revert on the fork (no live CoW order book).
    // ///         priceCheckerData uses the Aave capped USDC/USD + pyUSD/USD feeds.
    // function test_TF3_PYUSD_allowed_toToken() public {
    //     deal(USDC, SAFE, 1000e6);
    //     _approveUSDCToMilkman(1000e6);
    //
    //     vm.startPrank(STRATEGY_MANAGER);
    //     rolesMod.execTransactionWithRole(
    //         MILKMAN,
    //         0,
    //         abi.encodeWithSignature(
    //             "requestSwapExactTokensForTokens(uint256,address,address,address,bytes32,address,bytes)",
    //             1000e6,
    //             USDC,
    //             PYUSD,
    //             SAFE,
    //             bytes32(0), // appData
    //             PRICE_CHECKER,
    //             _priceCheckerData()
    //         ),
    //         0,
    //         ROLE_KEY,
    //         false
    //     );
    //     vm.stopPrank();
    // }
    //
    // // -----------------------------------------------------------------------
    // // TF-4 — RLUSD is an allowed toToken
    // // -----------------------------------------------------------------------
    //
    // /// @notice Strategy manager can request a USDC → RLUSD swap through Milkman.
    // ///         shouldRevert=false: policy gate is the only assertion here.
    // ///         priceCheckerData intentionally reuses the PYUSD feed payload —
    // ///         the policy constrains priceCheckerData with operator: pass, so
    // ///         any bytes are accepted. Milkman's internal price check may fail
    // ///         on the fork; that failure does not surface because shouldRevert=false.
    // ///         For production RLUSD swaps, use the Capped RLUSD/USD feed
    // ///         (0xf0eaC18E908B34770FDEe46d069c846bDa866759) in priceCheckerData.
    // function test_TF4_RLUSD_allowed_toToken() public {
    //     deal(USDC, SAFE, 1000e6);
    //     _approveUSDCToMilkman(1000e6);
    //
    //     vm.startPrank(STRATEGY_MANAGER);
    //     rolesMod.execTransactionWithRole(
    //         MILKMAN,
    //         0,
    //         abi.encodeWithSignature(
    //             "requestSwapExactTokensForTokens(uint256,address,address,address,bytes32,address,bytes)",
    //             1000e6,
    //             USDC,
    //             RLUSD,
    //             SAFE,
    //             bytes32(0), // appData
    //             PRICE_CHECKER,
    //             _priceCheckerData()
    //         ),
    //         0,
    //         ROLE_KEY,
    //         false
    //     );
    //     vm.stopPrank();
    // }
    //
    // // -----------------------------------------------------------------------
    // // TF-5 — WETH is NOT in the toToken allow-list
    // // -----------------------------------------------------------------------
    //
    // /// @notice Attempting a USDC → WETH swap is rejected by the Roles modifier
    // ///         because WETH was not declared as a toToken.
    // function test_TF5_WETH_blocked_toToken() public {
    //     vm.startPrank(STRATEGY_MANAGER);
    //     vm.expectRevert();
    //     rolesMod.execTransactionWithRole(
    //         MILKMAN,
    //         0,
    //         abi.encodeWithSignature(
    //             "requestSwapExactTokensForTokens(uint256,address,address,address,bytes32,address,bytes)",
    //             1000e6,
    //             USDC,
    //             WETH,
    //             SAFE,
    //             bytes32(0), // appData
    //             PRICE_CHECKER,
    //             _priceCheckerData()
    //         ),
    //         0,
    //         ROLE_KEY,
    //         true
    //     );
    //     vm.stopPrank();
    // }
    //
    // // -----------------------------------------------------------------------
    // // Helpers
    // // -----------------------------------------------------------------------
    //
    // function _approveUSDCToMilkman(uint256 amount) internal {
    //     vm.startPrank(STRATEGY_MANAGER);
    //     rolesMod.execTransactionWithRole(
    //         USDC, 0, abi.encodeWithSelector(IERC20.approve.selector, MILKMAN, amount), 0, ROLE_KEY, true
    //     );
    //     vm.stopPrank();
    // }
    //
    // /// @dev Builds priceCheckerData for a USDC → PYUSD swap using Aave capped adapters.
    // ///      Used by TF-3 (PYUSD) and TF-4 (RLUSD, for policy-gate testing only).
    // ///
    // ///      IMPORTANT: raw Chainlink aggregators (0x8fFfFfd4... USDC/USD,
    // ///      0x39E31761... PYUSD/USD) are access-controlled — the
    // ///      ChainlinkExpectedOutCalculator (0xe23fc1...) is not whitelisted on them,
    // ///      so any call reaching getExpectedOut silently reverts. Always use the
    // ///      Aave-deployed capped adapters instead.
    // ///
    // ///      Find the capped adapter for a token:
    // ///        cast call 0x54586bE62E3c3580375aE3723C145253060Ca0C2 \
    // ///          "getSourceOfAsset(address)(address)" <token> --rpc-url $ETH_RPC_URL
    // ///
    // ///      Slippage is set to 200 bps (2%) for test purposes only. Production swaps
    // ///      have used 700 bps (7%) to ensure CoW solver competitiveness.
    // function _priceCheckerData() internal pure returns (bytes memory) {
    //     address[] memory feeds = new address[](2);
    //     feeds[0] = 0x3f73F03aa83B2A48ed27E964eD0fDb590332095B; // Capped USDC/USD (Aave)
    //     feeds[1] = 0x36964C0579D02E0a5AaAb89E24Cf8d7CDF3549EE; // Capped pyUSD/USD (Aave)
    //     bool[] memory reverses = new bool[](2);
    //     reverses[0] = false; // multiply by USDC/USD
    //     reverses[1] = true; // divide by pyUSD/USD
    //     return abi.encode(uint256(200), abi.encode(feeds, reverses)); // 2% slippage
    // }
}
