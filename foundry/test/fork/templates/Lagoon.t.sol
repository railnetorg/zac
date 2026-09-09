// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @dev Lagoon v0.6.0 surface. The first seven are the functions `lagoon.tmpl` grants; the
///      block below them are real vault functions deliberately left OUT of the policy, every
///      one of them verified present in the deployed implementation.
interface ILagoonVault {
    // Granted:
    function updateNewTotalAssets(uint256 newTotalAssets) external;
    function settleDeposit(uint256 newTotalAssets) external;
    function settleRedeem(uint256 newTotalAssets) external;
    function expireTotalAssets() external;
    function updateTotalAssetsLifespan(uint128 lifespan) external;
    function claimSharesOnBehalf(address[] calldata controllers) external;
    function claimAssetsOnBehalf(address[] calldata controllers) external;
    // Not in policy:
    function setSyncMode(uint8 mode) external;
    function updateMaxCap(uint256 maxCap) external;
    function addToWhitelist(address[] calldata accounts) external;
    function close(uint256 newTotalAssets) external;
    function requestDeposit(uint256 assets, address controller, address owner) external returns (uint256);
    // Views.
    function asset() external view returns (address);
    function safe() external view returns (address);
    function version() external view returns (string memory);
}

/// @title  LagoonRoleMainnetTest
/// @notice Mainnet-fork acceptance test for `templates/lagoon/lagoon.tmpl`.
/// @dev    The policy is the CURATOR side of a Lagoon vault: the Safe settles epochs and
///         manages the NAV valuation, and approves the vault to pull its underlying. It is
///         not a depositor policy — the Safe never requests or claims for itself.
///
///         Coverage matrix:
///           • one happy-path case per granted function,
///           • the two scoped parameters on `approve` (target token, pinned spender),
///           • a block of real-but-not-granted vault functions,
///           • the target axis (a granted selector on a different address),
///           • the execution-mode axis (`execution_options: "none"` refuses ETH and
///             delegatecall on every grant).
///
///         The seven vault functions are all `onlySafe` on the vault, and the fixture Safe is
///         NOT this vault's safe, so none of them can execute here. Their happy paths use
///         `shouldRevert=false`: a policy rejection reverts (`ConditionViolation`) whatever
///         that flag says, while a vault-level refusal is swallowed to `ok=false`. So a call
///         that does NOT revert proves the policy gate allowed it. `approve` is genuinely
///         executable — it targets USDC, not the vault — so its happy path asserts the
///         resulting allowance instead.
///
///         `MAINNET_RPC_URL` must be set.
contract LagoonRoleMainnetTest is ZacForkTest {
    /// "CoinShares USDC IG Diversified Income" — a live Lagoon vault, `version()` = "v0.6.0".
    address constant VAULT = 0x30A3699E0DCea6bDC8bB2C13e74a2324e0B20116;
    /// The vault's own `asset()`, and the only token the approve role is scoped on.
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    /// A token the policy says nothing about.
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    /// A second live Lagoon vault, used for the target axis: same ABI, not in the policy.
    address constant OTHER_VAULT = 0x8b21Fa55e3AFC537dE8ABB74b2068746c676c828;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;

    uint256 constant AMOUNT = 1_000e6; // 1000 USDC; every granted amount is `pass`.
    uint256 constant NAV = 42e6; // Arbitrary: the NAV argument is `pass` everywhere.

    /// @dev `encodeKey('LAGOON')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x4c41474f4f4e0000000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "lagoon.zac.yaml");
    }

    /// @dev Assert the policy gate ALLOWS `data` to `to`. `shouldRevert=false` swallows a
    ///      vault-level refusal to `ok=false`; only a policy rejection reverts. Reaching the
    ///      end without reverting ⇒ allowed.
    function _assertPolicyAllows(address to, bytes memory data) internal {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(to, 0, data, CALL, ROLE_KEY, false);
    }

    function _controllers() internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = BOGUS;
    }

    // ==================== Fixture sanity ====================

    /// TL-0 — the fixture points at the vault the policy was rendered for, and that vault is
    ///        the v0.6.0 shape the template's settlement flow assumes. A vault swapped under
    ///        the test would make every case below assert against the wrong ABI.
    function test_TL0_FixtureVaultMatchesThePolicy() public view {
        assertEq(ILagoonVault(VAULT).asset(), USDC, "vault asset is not the approve-scoped token");
        assertEq(ILagoonVault(VAULT).version(), "v0.6.0", "vault is not the assumed version");
        assertTrue(ILagoonVault(VAULT).safe() != safeAddr, "fixture Safe is the vault's own safe");
    }

    // ==================== approve(spender, amount) on USDC ====================

    /// TL-1 — happy: approve the vault to pull the underlying. Genuinely executable, so this
    ///        asserts the allowance actually lands rather than just the gate decision. This is
    ///        the grant that lets the vault `transferFrom` the Safe on settlement.
    function test_TL1_ApproveVaultOnUnderlying() public {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr)
            .execTransactionWithRole(USDC, 0, abi.encodeCall(IERC20.approve, (VAULT, AMOUNT)), CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
        assertEq(IERC20(USDC).allowance(safeAddr, VAULT), AMOUNT, "Safe -> vault allowance did not update");
    }

    /// TL-2 — the spender is pinned: the Safe cannot approve anyone but the vault, so a
    ///        compromised member cannot hand the Safe's underlying to an arbitrary address.
    function test_TL2_ApproveForeignSpenderRejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    /// TL-3 — the approve role is scoped to the vault's own asset. The same selector on any
    ///        other token is a different target and is not in the policy.
    function test_TL3_ApproveOnOtherTokenRejected() public {
        expectPolicyReject(modAddr, ALICE, WETH, abi.encodeCall(IERC20.approve, (VAULT, AMOUNT)), CALL, ROLE_KEY);
    }

    // ==================== The settlement surface ====================

    /// TL-4 — the NAV proposal. Inert on this vault (an external provider holds
    ///        valuationManager) but granted, so the same policy serves a vault where the Safe
    ///        holds that role. The gate must admit it either way.
    function test_TL4_UpdateNewTotalAssetsAllowed() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(ILagoonVault.updateNewTotalAssets, (NAV)));
    }

    /// TL-5 — the deposit half of settlement: the Safe confirms the proposed NAV.
    function test_TL5_SettleDepositAllowed() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(ILagoonVault.settleDeposit, (NAV)));
    }

    /// TL-6 — the redeem half. This is the call that pulls `convertToAssets(pendingShares)`
    ///        from the Safe, which is what the approve in TL-1 is for.
    function test_TL6_SettleRedeemAllowed() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(ILagoonVault.settleRedeem, (NAV)));
    }

    /// TL-7 — force the cached valuation to expire, so a fresh one can be proposed
    ///        back-to-back.
    function test_TL7_ExpireTotalAssetsAllowed() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(ILagoonVault.expireTotalAssets, ()));
    }

    /// TL-9 — push minted shares to depositors after settlement.
    function test_TL9_ClaimSharesOnBehalfAllowed() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(ILagoonVault.claimSharesOnBehalf, (_controllers())));
    }

    /// TL-10 — push redeemed assets to redeemers after settlement.
    function test_TL10_ClaimAssetsOnBehalfAllowed() public {
        _assertPolicyAllows(VAULT, abi.encodeCall(ILagoonVault.claimAssetsOnBehalf, (_controllers())));
    }

    // ==================== Real vault functions NOT granted ====================

    /// TL-11 — `setSyncMode` decides whether the vault's synchronous deposit and redeem
    ///        entrypoints are reachable at all. The ERC7540Vehicle that wraps this vault
    ///        assumes they never are, so re-opening them would break its accounting from
    ///        outside the vehicle entirely. The curator policy must not carry it.
    function test_TL11_SetSyncModeRejected() public {
        expectPolicyReject(modAddr, ALICE, VAULT, abi.encodeCall(ILagoonVault.setSyncMode, (0)), CALL, ROLE_KEY);
    }

    /// TL-11b — `updateTotalAssetsLifespan` is unreachable on an async-only vault: activating
    ///        that mode zeroes the lifespan and shuts the setter, so the call reverts
    ///        `AsyncOnly()` from any caller for the life of the vault. Granting it would be
    ///        authority nobody can exercise, so the policy leaves it out and this pins that.
    function test_TL11b_UpdateTotalAssetsLifespanRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            VAULT,
            abi.encodeCall(ILagoonVault.updateTotalAssetsLifespan, (uint128(1 days))),
            CALL,
            ROLE_KEY
        );
    }

    /// TL-12 — the deposit cap is a mandate parameter, not a settlement operation.
    function test_TL12_UpdateMaxCapRejected() public {
        expectPolicyReject(
            modAddr, ALICE, VAULT, abi.encodeCall(ILagoonVault.updateMaxCap, (type(uint256).max)), CALL, ROLE_KEY
        );
    }

    /// TL-13 — who may participate in the vault is the whitelist manager's call, not the
    ///        curator's, even when one Safe happens to hold both roles.
    function test_TL13_AddToWhitelistRejected() public {
        expectPolicyReject(
            modAddr, ALICE, VAULT, abi.encodeCall(ILagoonVault.addToWhitelist, (_controllers())), CALL, ROLE_KEY
        );
    }

    /// TL-14 — closing the vault is terminal: a closed Lagoon vault can never settle another
    ///        deposit epoch, which would strand every vehicle built on it.
    function test_TL14_CloseRejected() public {
        expectPolicyReject(modAddr, ALICE, VAULT, abi.encodeCall(ILagoonVault.close, (NAV)), CALL, ROLE_KEY);
    }

    /// TL-15 — this is a curator policy, not a depositor one. The Safe settles other people's
    ///        requests; it does not take a position in the vault it operates.
    function test_TL15_RequestDepositRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            VAULT,
            abi.encodeCall(ILagoonVault.requestDeposit, (AMOUNT, safeAddr, safeAddr)),
            CALL,
            ROLE_KEY
        );
    }

    /// TL-16 — the vault contract is itself the share token. Moving shares is not part of the
    ///        curator surface.
    function test_TL16_VaultShareTransferRejected() public {
        expectPolicyReject(modAddr, ALICE, VAULT, abi.encodeCall(IERC20.transfer, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ==================== Target axis ====================

    /// TL-17 — one vault per config. A granted selector against a different Lagoon vault —
    ///        same ABI, same shape — is rejected, so the policy cannot be pointed at someone
    ///        else's vault.
    function test_TL17_SettleOnAnotherVaultRejected() public {
        expectPolicyReject(
            modAddr, ALICE, OTHER_VAULT, abi.encodeCall(ILagoonVault.settleDeposit, (NAV)), CALL, ROLE_KEY
        );
    }

    // ==================== ExecutionOptions axis ====================
    //
    // Every grant in this template sets `execution_options: "none"`, and the cases below are
    // the only thing that would notice if one of them became `send`, `delegatecall` or `both`.
    // Every other test in this suite passes `value=0` and `operation=Call`, so all of them
    // stay green under that edit.

    /// TL-18 — the role may not execute in the avatar's storage context. A delegatecall into
    ///        the vault would run 24kB of Lagoon against the SAFE's storage.
    function test_TL18_DelegatecallToVaultRejected() public {
        expectPolicyReject(
            modAddr, ALICE, VAULT, abi.encodeCall(ILagoonVault.settleDeposit, (NAV)), DELEGATECALL, ROLE_KEY
        );
    }

    /// TL-19 — same on the underlying: `approve` is granted, but only as a plain call.
    function test_TL19_DelegatecallToUnderlyingRejected() public {
        expectPolicyReject(
            modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (VAULT, AMOUNT)), DELEGATECALL, ROLE_KEY
        );
    }

    /// TL-20 — the role may not attach the Safe's ETH. Rejected at the gate, so the Safe needs
    ///        no balance for this to hold.
    function test_TL20_ValueAttachedRejected() public {
        expectPolicyRejectWithValue(
            modAddr, ALICE, VAULT, 1 wei, abi.encodeCall(ILagoonVault.settleDeposit, (NAV)), CALL, ROLE_KEY
        );
    }
}
