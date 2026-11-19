// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";
import {USDC} from "../chainConfigs/MainnetAddresses.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev The USDY Instant Manager surface `ondo_usdy.tmpl` grants.
interface IUsdyInstantManager {
    function subscribe(address depositToken, uint256 depositAmount, uint256 minimumRwaReceived)
        external
        returns (uint256 rwaAmountOut);
    function redeem(uint256 rwaAmount, address receivingToken, uint256 minimumTokenReceived)
        external
        returns (uint256 receiveTokenAmount);
}

/// @dev Ondo's ID registry: the Instant Manager serves only callers registered for USDY.
interface IOndoIDRegistry {
    function getRegisteredID(address rwaToken, address user) external view returns (bytes32);
}

/// @dev The Zodiac Modifier base raises this when the caller is not an enabled module on
///      the Roles modifier. It fires before any role or scoping check. Selector 0x4a0bfec1.
error NotAuthorized(address sender);

/// @title  OndoUsdyRoleMainnetTest
/// @notice Mainnet-fork test for `templates/ondo_usdy/ondo_usdy.tmpl`, using the shared
///         `ZacForkTest` harness. Happy path: approve, subscribe USDC into USDY, approve,
///         redeem USDY back into USDC, all through the role. Then rejections: wrong payment
///         asset, wrong spender, wrong token, a USDY transfer, non-member, ETH value,
///         delegatecall.
/// @dev    The fixture Safe is fresh, so Ondo has never registered it. The happy path mocks the
///         registry's answer for it, which is what Ondo's onboarding records for a real Safe.
contract OndoUsdyRoleMainnetTest is ZacForkTest {
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant USDY = 0x96F6eF951840721AdBF46Ac996b59E0235CB985C;
    address constant INSTANT_MANAGER = 0xa42613C243b67BF6194Ac327795b926B4b491f15;
    address constant ONDO_ID_REGISTRY = 0xcf6958D69d535FD03BD6Df3F4fe6CDcd127D97df;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;
    uint256 constant AMOUNT = 10_000e6; // 10,000 USDC, 6 decimals.

    /// @dev `encodeKey('ONDO_USDY')`: ASCII, right-padded to 32 bytes.
    bytes32 constant ROLE_KEY = 0x4f4e444f5f555344590000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "ondo_usdy.zac.yaml");
    }

    // ============================================================
    // Happy path: subscribe then redeem, through the role
    // ============================================================

    /// USDC goes in, USDY comes out, and USDY redeems back into USDC.
    function test_subscribe_redeem_happy() public {
        vm.mockCall(
            ONDO_ID_REGISTRY,
            abi.encodeCall(IOndoIDRegistry.getRegisteredID, (USDY, safeAddr)),
            abi.encode(bytes32(uint256(1)))
        );
        deal(USDC, safeAddr, AMOUNT);

        _ok(USDC, abi.encodeCall(IERC20.approve, (INSTANT_MANAGER, AMOUNT)));
        _ok(INSTANT_MANAGER, abi.encodeCall(IUsdyInstantManager.subscribe, (USDC, AMOUNT, 0)));
        uint256 usdy = IERC20(USDY).balanceOf(safeAddr);
        assertGt(usdy, 0, "no USDY minted");
        assertEq(IERC20(USDC).balanceOf(safeAddr), 0, "USDC left on the Safe");

        _ok(USDY, abi.encodeCall(IERC20.approve, (INSTANT_MANAGER, usdy)));
        _ok(INSTANT_MANAGER, abi.encodeCall(IUsdyInstantManager.redeem, (usdy, USDC, 0)));
        assertEq(IERC20(USDY).balanceOf(safeAddr), 0, "USDY left on the Safe");
        assertGt(IERC20(USDC).balanceOf(safeAddr), 0, "no USDC redeemed");
    }

    // ============================================================
    // Scoped parameters
    // ============================================================

    /// Subscribing with a payment asset outside the list (USDT) is rejected.
    function test_subscribe_wrongAsset_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            INSTANT_MANAGER,
            abi.encodeCall(IUsdyInstantManager.subscribe, (USDT, AMOUNT, 0)),
            CALL,
            ROLE_KEY
        );
    }

    /// Redeeming into a payment asset outside the list (USDT) is rejected.
    function test_redeem_wrongAsset_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            INSTANT_MANAGER,
            abi.encodeCall(IUsdyInstantManager.redeem, (AMOUNT, USDT, 0)),
            CALL,
            ROLE_KEY
        );
    }

    /// USDC can only be approved to the Instant Manager.
    function test_approve_wrongSpender_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ============================================================
    // Wrong selector or wrong target
    // ============================================================

    /// Approving a token outside the policy (USDT) is rejected.
    function test_nonAllowedTarget_usdtApprove_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, USDT, abi.encodeCall(IERC20.approve, (INSTANT_MANAGER, AMOUNT)), CALL, ROLE_KEY
        );
    }

    /// USDY can't leave the Safe by `transfer`: only the Instant Manager takes it, on redeem.
    function test_nonAllowed_usdyTransfer_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDY, abi.encodeCall(IERC20.transfer, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
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
                INSTANT_MANAGER,
                0,
                abi.encodeCall(IUsdyInstantManager.subscribe, (USDC, AMOUNT, 0)),
                CALL,
                ROLE_KEY,
                true
            );
    }

    /// Attaching ETH to an otherwise valid call is rejected (`execution_options: none`).
    function test_sendValue_rejected() public {
        vm.prank(ALICE);
        vm.expectPartialRevert(ROLES_CONDITION_VIOLATION);
        IRoles(modAddr)
            .execTransactionWithRole(
                INSTANT_MANAGER,
                1,
                abi.encodeCall(IUsdyInstantManager.subscribe, (USDC, AMOUNT, 0)),
                CALL,
                ROLE_KEY,
                true
            );
    }

    /// Delegatecall is rejected (`execution_options: none`).
    function test_delegatecall_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            INSTANT_MANAGER,
            abi.encodeCall(IUsdyInstantManager.subscribe, (USDC, AMOUNT, 0)),
            DELEGATECALL,
            ROLE_KEY
        );
    }

    // ============================================================
    // Helpers
    // ============================================================

    /// @dev Execute `data` on `to` as the role member and require success.
    function _ok(address to, bytes memory data) internal {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr).execTransactionWithRole(to, 0, data, CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
    }
}
