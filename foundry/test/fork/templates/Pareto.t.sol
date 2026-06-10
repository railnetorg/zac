// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @dev Lender-side surface of the Pareto Credit Vault (Idle CDO epoch variant). Only the
///      first five functions are granted by `pareto.tmpl`; `withdrawAA`/`withdrawBB`/`deposit`
///      are real CDO functions deliberately left OUT of the policy (used as negative cases).
interface IParetoCDO {
    function depositAA(uint256 _amount) external returns (uint256);
    function depositBB(uint256 _amount) external returns (uint256);
    function requestWithdraw(uint256 _amount, address _tranche) external returns (uint256);
    function claimWithdrawRequest() external;
    function claimInstantWithdrawRequest() external;
    // Not in policy:
    function withdrawAA(uint256 _amount) external returns (uint256);
    function withdrawBB(uint256 _amount) external returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256);
}

/// @title  ParetoRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/pareto/pareto.tmpl` policy (lender
///         side), driven by the shared `ZacForkTest` harness.
/// @dev    Coverage matrix — for every call the policy grants:
///           • one happy-path test (in-scope params clear the gate), and
///           • one out-of-scope test per scoped parameter.
///         Plus a block of non-allowed-method / non-allowed-target rejections.
///
///         Allowed calls (policy from `falconx_usdc`, which has both tranches):
///           USDC.approve(spender ∈ {VAULT}, amount=pass)
///           VAULT.depositAA(amount=pass)
///           VAULT.depositBB(amount=pass)
///           VAULT.requestWithdraw(amount=pass, _tranche ∈ {AA, BB})
///           VAULT.claimWithdrawRequest()
///           VAULT.claimInstantWithdrawRequest()
///
///         Happy paths for the non-executable vault calls use `shouldRevert=false`: a policy
///         rejection still reverts (`ConditionViolation`), while a protocol-level revert is
///         swallowed to `ok=false`. So a call that does NOT revert proves the policy gate
///         allowed it (see `_assertPolicyAllows`). `approve` is genuinely executable, so its
///         happy path asserts the resulting allowance instead.
contract ParetoRoleMainnetTest is ZacForkTest {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // Pareto Credit Vault "FalconX USDC" (aliases.pareto.falconx_usdc) and its tranches.
    address constant VAULT = 0x433D5B175148dA32Ffe1e1A37a939E1b7e79be4d;
    address constant AA_TRANCHE = 0xC26A6Fa2C37b38E549a4a1807543801Db684f99C;
    address constant BB_TRANCHE = 0xacbb25b7DD30B6B2F7131865Dc1023622de3b3D6;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint256 constant AMOUNT = 1_000_000; // 1 USDC (6 decimals); `amount` is `pass` everywhere.

    /// @dev `encodeKey('PARETO')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x50415245544f0000000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "pareto.zac.yaml");
    }

    // ============================================================
    // approve(spender, amount) on USDC — scoped param: spender
    // ============================================================

    /// happy: approve the in-scope vault to pull USDC. This one executes for real.
    function test_approve_happy_vault() public {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr)
            .execTransactionWithRole(USDC, 0, abi.encodeCall(IERC20.approve, (VAULT, AMOUNT)), CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
        assertEq(IERC20(USDC).allowance(safeAddr, VAULT), AMOUNT, "Safe -> vault allowance did not update");
    }

    /// out-of-scope `spender`: approving any non-vault spender is rejected.
    function test_approve_wrongSpender_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ============================================================
    // depositAA(amount) on VAULT — no scoped params (amount=pass)
    // ============================================================

    function test_depositAA_happy() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(IParetoCDO.depositAA, (AMOUNT)));
    }

    // ============================================================
    // depositBB(amount) on VAULT — no scoped params (amount=pass)
    // ============================================================

    function test_depositBB_happy() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(IParetoCDO.depositBB, (AMOUNT)));
    }

    // ============================================================
    // requestWithdraw(amount, _tranche) on VAULT — scoped param: _tranche ∈ {AA, BB}
    // ============================================================

    function test_requestWithdraw_happy_AA() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(IParetoCDO.requestWithdraw, (AMOUNT, AA_TRANCHE)));
    }

    function test_requestWithdraw_happy_BB() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(IParetoCDO.requestWithdraw, (AMOUNT, BB_TRANCHE)));
    }

    /// out-of-scope `_tranche`: an address that is neither AA nor BB is rejected.
    function test_requestWithdraw_wrongTranche_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, VAULT, abi.encodeCall(IParetoCDO.requestWithdraw, (AMOUNT, BOGUS)), CALL, ROLE_KEY
        );
    }

    // ============================================================
    // claimWithdrawRequest() / claimInstantWithdrawRequest() on VAULT — no params
    // ============================================================

    function test_claimWithdrawRequest_happy() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(IParetoCDO.claimWithdrawRequest, ()));
    }

    function test_claimInstantWithdrawRequest_happy() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(IParetoCDO.claimInstantWithdrawRequest, ()));
    }

    // ============================================================
    // Non-allowed methods (allowed target, selector NOT in policy)
    // ============================================================

    /// withdrawAA is a real CDO function but the lender policy only grants the request/claim
    /// flow — the instant `withdrawAA` is not allowed.
    function test_nonAllowed_withdrawAA_rejected() public {
        expectPolicyReject(modAddr, ALICE, VAULT, abi.encodeCall(IParetoCDO.withdrawAA, (AMOUNT)), CALL, ROLE_KEY);
    }

    function test_nonAllowed_withdrawBB_rejected() public {
        expectPolicyReject(modAddr, ALICE, VAULT, abi.encodeCall(IParetoCDO.withdrawBB, (AMOUNT)), CALL, ROLE_KEY);
    }

    /// A generic ERC4626-style deposit selector is not part of the policy.
    function test_nonAllowed_deposit_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, VAULT, abi.encodeCall(IParetoCDO.deposit, (AMOUNT, safeAddr)), CALL, ROLE_KEY
        );
    }

    /// On USDC only `approve` is granted — `transfer` (a different selector) is rejected.
    function test_nonAllowed_usdcTransfer_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.transfer, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ============================================================
    // Non-allowed targets (correct selector, target NOT in policy)
    // ============================================================

    /// `approve` is only scoped on USDC; the same selector on a different token is rejected.
    function test_nonAllowedTarget_approveOtherToken_rejected() public {
        expectPolicyReject(modAddr, ALICE, WETH, abi.encodeCall(IERC20.approve, (VAULT, AMOUNT)), CALL, ROLE_KEY);
    }

    /// An allowed selector aimed at an entirely out-of-policy target is rejected.
    function test_nonAllowedTarget_depositAA_rejected() public {
        expectPolicyReject(modAddr, ALICE, BOGUS, abi.encodeCall(IParetoCDO.depositAA, (AMOUNT)), CALL, ROLE_KEY);
    }

    /// requestWithdraw aimed at the USDC token (wrong venue) is rejected even with a valid tranche.
    function test_nonAllowedTarget_requestWithdrawOnToken_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, USDC, abi.encodeCall(IParetoCDO.requestWithdraw, (AMOUNT, AA_TRANCHE)), CALL, ROLE_KEY
        );
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
}
