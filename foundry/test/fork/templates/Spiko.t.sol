// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";
import {USDC} from "../chainConfigs/MainnetAddresses.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Spiko's on-chain redemption entrypoint on a share token. `spiko.tmpl` does not grant
///      it; used here as a negative case.
interface ISpikoToken {
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);
}

/// @dev The Zodiac Modifier base raises this when the caller is not an enabled module on
///      the Roles modifier. It fires before any role or scoping check. Selector 0x4a0bfec1.
error NotAuthorized(address sender);

/// @title  SpikoRoleMainnetTest
/// @notice Mainnet-fork test for `templates/spiko/spiko.tmpl`, using the shared `ZacForkTest`
///         harness. The fixture grants USDC.transfer to two deposit addresses. Happy path per
///         address, then rejections: wrong recipient, wrong selector, wrong target,
///         non-member, ETH value, delegatecall.
contract SpikoRoleMainnetTest is ZacForkTest {
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant USTBL = 0xe4880249745eAc5F1eD9d8F7DF844792D560e750;
    address constant SPIKO_REDEMPTION = 0xDA5599f04e9b437C8394b0c2BC68B502A66ebFe8;
    // Stand-ins for the deposit addresses Spiko assigns. Must match the fixture.
    address constant SUBSCRIPTION = 0x2222222222222222222222222222222222222222;
    address constant SUBSCRIPTION_2 = 0x3333333333333333333333333333333333333333;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;
    uint256 constant AMOUNT = 1_000_000; // 1 USDC, 6 decimals. `value` is never scoped.

    /// @dev `encodeKey('SPIKO')`: ASCII, right-padded to 32 bytes.
    bytes32 constant ROLE_KEY = 0x5350494b4f000000000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "spiko.zac.yaml");
    }

    // ============================================================
    // transfer(to, value) on USDC. Scoped: to in {SUBSCRIPTION, SUBSCRIPTION_2}
    // ============================================================

    /// USDC to the first deposit address goes through and the balances move.
    function test_transfer_happy() public {
        _transferOk(SUBSCRIPTION);
    }

    /// The second listed deposit address is accepted too.
    function test_transfer_happy_secondAddress() public {
        _transferOk(SUBSCRIPTION_2);
    }

    /// Any recipient outside the list is rejected.
    function test_transfer_wrongRecipient_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.transfer, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ============================================================
    // Wrong selector or wrong target
    // ============================================================

    /// `approve` on USDC is not in the policy. Nothing can pull USDC from the Safe.
    function test_nonAllowed_usdcApprove_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (SUBSCRIPTION, AMOUNT)), CALL, ROLE_KEY);
    }

    /// The same transfer on a token outside the policy (USDT) is rejected.
    function test_nonAllowedTarget_usdtTransfer_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, USDT, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, AMOUNT)), CALL, ROLE_KEY
        );
    }

    /// Spiko's on-chain redemption call on the share token is not granted.
    function test_nonAllowedTarget_ustblRedeem_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            USTBL,
            abi.encodeCall(ISpikoToken.transferAndCall, (SPIKO_REDEMPTION, AMOUNT, abi.encode(address(0), bytes32(0)))),
            CALL,
            ROLE_KEY
        );
    }

    // ============================================================
    // Modifier-wide rules
    // ============================================================

    /// A caller that was never enabled on the modifier is rejected before any role or scoping check.
    function test_nonMember_rejected() public {
        vm.prank(BOGUS);
        vm.expectRevert(abi.encodeWithSelector(NotAuthorized.selector, BOGUS));
        IRoles(modAddr)
            .execTransactionWithRole(
                USDC, 0, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, AMOUNT)), CALL, ROLE_KEY, true
            );
    }

    /// Attaching ETH to an otherwise valid call is rejected (`execution_options: none`).
    function test_sendValue_rejected() public {
        vm.prank(ALICE);
        vm.expectPartialRevert(ROLES_CONDITION_VIOLATION);
        IRoles(modAddr)
            .execTransactionWithRole(
                USDC, 1, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, AMOUNT)), CALL, ROLE_KEY, true
            );
    }

    /// Delegatecall is rejected (`execution_options: none`).
    function test_delegatecall_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, USDC, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, AMOUNT)), DELEGATECALL, ROLE_KEY
        );
    }

    // ============================================================
    // Helpers
    // ============================================================

    /// @dev Fund the Safe, send USDC to `to` through the role, and check both balances moved.
    function _transferOk(address to) internal {
        deal(USDC, safeAddr, AMOUNT);
        uint256 before = IERC20(USDC).balanceOf(to);
        vm.prank(ALICE);
        bool ok = IRoles(modAddr)
            .execTransactionWithRole(USDC, 0, abi.encodeCall(IERC20.transfer, (to, AMOUNT)), CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
        assertEq(IERC20(USDC).balanceOf(to) - before, AMOUNT, "USDC did not reach the deposit address");
        assertEq(IERC20(USDC).balanceOf(safeAddr), 0, "Safe still holds the USDC");
    }
}
