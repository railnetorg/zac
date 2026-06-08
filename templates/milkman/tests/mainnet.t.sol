// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

/// @dev Minimal ERC20 surface used by the assertions.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title  MilkmanRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/milkman/milkman.tmpl` policy
///         in its per-token-pair slippage-cap form.
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `policy.zac.yaml` fixture against the fresh Modifier.
///         `RPC_URL` must be set.
///
///         The fixture configures two pairs with distinct caps:
///           USDC → PYUSD, slippage ≤ 500 bps
///           USDC → RLUSD, slippage ≤ 700 bps
///         so the function root is an `or` of two branches. Each branch pins
///         (fromToken, toToken, to=avatar, priceChecker) and bounds the swap's
///         priceCheckerData, which the Chainlink DynamicSlippageChecker ABI-encodes
///         as (uint256 slippageBps, bytes innerData): slippageBps is capped per pair,
///         innerData (feed config) is free.
///
///         Swap "allow" tests use `shouldRevert=false`: the policy gate is the only
///         assertion. Milkman's inner logic may fail on the fork, but a gate rejection
///         would revert regardless, so a clean return proves the policy authorised the
///         call. The end-to-end swap has been proven on mainnet: tx
///         0x8fc655d21985dc3af30643aec7d3e3c6ceb3389edc109fb09eeeded9178e69e6
///         (14 USDC → 13.435 PYUSD, filled by a CoW solver).
contract MilkmanRoleMainnetTest is ZacForkTest {
    // Mainnet protocol addresses referenced by the policy + assertions.
    address constant MILKMAN = 0x060373D064d0168931dE2AB8DDA7410923d06E88;
    address constant PRICE_CHECKER = 0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c;

    // Allowed tokens (fixture pairs: USDC→PYUSD ≤5%, USDC→RLUSD ≤7%).
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // fromToken ✓
    address constant PYUSD = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8; // toToken   ✓ (cap 500)
    address constant RLUSD = 0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD; // toToken   ✓ (cap 700)

    // Blocked tokens (no branch covers them).
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // fromToken ✗
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // toToken   ✗

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant NOT_MILKMAN = 0x000000000000000000000000000000000000dEaD;
    address constant WRONG_CHECKER = 0x000000000000000000000000000000000000bEEF;
    uint8 constant CALL = 0;
    uint256 constant AMOUNT = 1_000e6;

    /// @dev `encodeKey('STRATEGY_MANAGER')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = bytes32("STRATEGY_MANAGER");

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "milkman/tests/policy.zac.yaml");
    }

    // ==================== approve: spender == Milkman, amount < uint256.max ====================

    /// TF-1 — allow: approve USDC to Milkman for a normal amount; allowance is set.
    function test_TF1_ApproveMilkmanAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(USDC, 0, _approveCd(MILKMAN, AMOUNT), CALL, ROLE_KEY, true);
        assertEq(IERC20(USDC).allowance(safeAddr, MILKMAN), AMOUNT, "allowance not set");
    }

    /// TF-2 — allow: amount == uint256.max - 1 sits just under the cap (`less_than`).
    function test_TF2_ApproveJustUnderMaxAllowed() public {
        uint256 amt = type(uint256).max - 1;
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(USDC, 0, _approveCd(MILKMAN, amt), CALL, ROLE_KEY, true);
        assertEq(IERC20(USDC).allowance(safeAddr, MILKMAN), amt, "allowance not set");
    }

    /// TF-3 — deny: amount == uint256.max (infinite approval) breaches the `less_than` cap.
    function test_TF3_ApproveUnlimitedRejected() public {
        _expectReject(USDC, _approveCd(MILKMAN, type(uint256).max));
    }

    /// TF-4 — deny: approving any spender other than Milkman breaches `equal_to`.
    function test_TF4_ApproveWrongSpenderRejected() public {
        _expectReject(USDC, _approveCd(NOT_MILKMAN, AMOUNT));
    }

    // ==================== requestSwap: per-pair branch + slippage cap ====================

    /// TF-5 — allow: USDC → PYUSD at 200 bps, within the 500 bps cap.
    function test_TF5_SwapPyusdWithinCapAllowed() public {
        _swapAllowed(USDC, PYUSD, _pcd(200));
    }

    /// TF-6 — allow: USDC → RLUSD at 600 bps, within the 700 bps cap.
    function test_TF6_SwapRlusdWithinCapAllowed() public {
        _swapAllowed(USDC, RLUSD, _pcd(600));
    }

    /// TF-7 — deny: USDC → PYUSD at 501 bps exceeds the 500 bps cap (`less_than 501`).
    function test_TF7_SwapPyusdOverCapRejected() public {
        _expectReject(MILKMAN, _swap(USDC, PYUSD, safeAddr, PRICE_CHECKER, _pcd(501)));
    }

    /// TF-8 — deny: USDC → PYUSD at 600 bps. 600 is fine for the RLUSD branch (cap 700)
    ///        but not for PYUSD (cap 500): the cap is correlated to the exact pair, so
    ///        neither branch matches. This is the per-pair guarantee the `or` provides.
    function test_TF8_SwapPyusdWithRlusdCapRejected() public {
        _expectReject(MILKMAN, _swap(USDC, PYUSD, safeAddr, PRICE_CHECKER, _pcd(600)));
    }

    /// TF-9 — deny: toToken WETH is covered by no branch.
    function test_TF9_SwapToUnlistedTokenRejected() public {
        _expectReject(MILKMAN, _swap(USDC, WETH, safeAddr, PRICE_CHECKER, _pcd(200)));
    }

    /// TF-10 — deny: fromToken USDT is covered by no branch.
    function test_TF10_SwapFromUnlistedTokenRejected() public {
        _expectReject(MILKMAN, _swap(USDT, PYUSD, safeAddr, PRICE_CHECKER, _pcd(200)));
    }

    /// TF-11 — deny: receiver must be the Safe (avatar) in every branch.
    function test_TF11_SwapToForeignReceiverRejected() public {
        _expectReject(MILKMAN, _swap(USDC, PYUSD, ALICE, PRICE_CHECKER, _pcd(200)));
    }

    /// TF-12 — deny: priceChecker is pinned in every branch; a substitute is rejected.
    function test_TF12_SwapWrongPriceCheckerRejected() public {
        _expectReject(MILKMAN, _swap(USDC, PYUSD, safeAddr, WRONG_CHECKER, _pcd(200)));
    }

    /// TF-13 — allow: innerData (the feed config after slippageBps) is unconstrained;
    ///         a within-cap swap with arbitrary innerData still clears the gate.
    function test_TF13_SwapFreeInnerDataAllowed() public {
        bytes memory pcd = abi.encode(uint256(200), abi.encode("arbitrary feed config"));
        _swapAllowed(USDC, PYUSD, pcd);
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
    ///      innerData (feed config) is empty here — the policy leaves it free.
    function _pcd(uint256 slippageBps) internal pure returns (bytes memory) {
        return abi.encode(slippageBps, bytes(""));
    }

    function _approveCd(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    /// @dev requestSwap calldata with a fixed amountIn and empty appData.
    function _swap(
        address fromToken,
        address toToken,
        address to,
        address priceChecker,
        bytes memory priceCheckerData
    ) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "requestSwapExactTokensForTokens(uint256,address,address,address,bytes32,address,bytes)",
            AMOUNT,
            fromToken,
            toToken,
            to,
            bytes32(0),
            priceChecker,
            priceCheckerData
        );
    }
}
