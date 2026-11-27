// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";
import {USDC} from "../chainConfigs/MainnetAddresses.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev ERC-1363 entrypoint on a Spiko fund token, the one `redemption_request` grants.
interface ISpikoToken {
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);
}

/// @dev The ERC-1363 overload without `data`. Not granted.
interface ISpikoTokenNoData {
    function transferAndCall(address to, uint256 value) external returns (bool);
}

/// @dev Spiko's MultiATM. `multi_atm` grants `swapExactInputSingle` only.
interface IMultiATM {
    function previewExactInputSingle(address input, address output, uint256 inputAmount) external view returns (uint256);
    function swapExactInputSingle(
        address input,
        address output,
        uint256 inputAmount,
        address recipient,
        uint256 minOutputAmount
    ) external returns (uint256);
    function swapExactOutputSingle(
        address input,
        address output,
        uint256 outputAmount,
        address recipient,
        uint256 maxInputAmount
    ) external returns (uint256);
    function swapExactInput(address[] calldata path, uint256 inputAmount, address recipient, uint256 minOutputAmount)
        external
        returns (uint256);
}

/// @dev Spiko's Redemption contract: the ERC-1363 receiver that records redemption requests.
interface ISpikoRedemption {
    function details(bytes32 id) external view returns (uint8 status, uint48 deadline);
    function hashRedemptionId(address user, address input, address output, uint256 inputValue, bytes32 salt)
        external
        pure
        returns (bytes32);
    function cancelRedemption(address user, address input, address output, uint256 inputValue, bytes32 salt) external;
}

/// @dev Spiko's PermissionManager (OZ IAuthority): the whitelist behind every fund token and the ATM.
interface IAuthority {
    function canCall(address caller, address target, bytes4 selector) external view returns (bool);
}

/// @dev The Zodiac Modifier base raises this when the caller is not an enabled module on
///      the Roles modifier. It fires before any role or scoping check. Selector 0x4a0bfec1.
error NotAuthorized(address sender);

/// @dev Shared setup and helpers for the two `spiko.tmpl` routes.
/// @dev The fixture Safe is fresh, so Spiko has never whitelisted it. The happy paths mock
///      the PermissionManager's answer for it, which is what Spiko's onboarding records for a
///      real Safe. Every other address (the ATM, Redemption) keeps its live answer.
abstract contract SpikoForkBase is ZacForkTest {
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address constant USTBL = 0xe4880249745eAc5F1eD9d8F7DF844792D560e750;
    address constant SAFO = 0xcBaDe7D9BdEe88411CB6cbCbB29952b742036992;
    address constant MULTI_ATM = 0xBD6AD96f51E8d732811587468d0E2F9EFa55f605;
    address constant REDEMPTION = 0xDA5599f04e9b437C8394b0c2BC68B502A66ebFe8;
    address constant PERMISSION_MANAGER = 0x344278aff344d6fb960705dc18a4912221608472;
    // Stand-ins for the deposit addresses Spiko assigns. Must match the fixtures.
    address constant SUBSCRIPTION = 0x2222222222222222222222222222222222222222;
    address constant SUBSCRIPTION_2 = 0x3333333333333333333333333333333333333333;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;
    uint256 constant USDC_AMOUNT = 1_000_000; // 1 USDC, 6 decimals.
    uint256 constant FUND_AMOUNT = 100_000; // 1 fund token, 5 decimals.
    bytes32 constant SALT = bytes32(uint256(0xa11ce));

    /// @dev `encodeKey('SPIKO')`: ASCII, right-padded to 32 bytes.
    bytes32 constant ROLE_KEY = 0x5350494b4f000000000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function fixture() internal pure virtual returns (string memory);

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, fixture());
    }

    /// @dev Spiko whitelists the Safe: `canCall(safe, *, *)` answers true.
    function _whitelistSafe() internal {
        vm.mockCall(PERMISSION_MANAGER, abi.encodeWithSelector(IAuthority.canCall.selector, safeAddr), abi.encode(true));
    }

    /// @dev Execute `data` on `to` through the role and require success.
    function _ok(address to, bytes memory data) internal {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr).execTransactionWithRole(to, 0, data, CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
    }

    function _reject(address to, bytes memory data) internal {
        expectPolicyReject(modAddr, ALICE, to, data, CALL, ROLE_KEY);
    }

    /// @dev Fund the Safe, send USDC to `to` through the role, and check both balances moved.
    function _transferOk(address to) internal {
        deal(USDC, safeAddr, USDC_AMOUNT);
        uint256 before = IERC20(USDC).balanceOf(to);
        _ok(USDC, abi.encodeCall(IERC20.transfer, (to, USDC_AMOUNT)));
        assertEq(IERC20(USDC).balanceOf(to) - before, USDC_AMOUNT, "USDC did not reach the deposit address");
        assertEq(IERC20(USDC).balanceOf(safeAddr), 0, "Safe still holds the USDC");
    }

    function _redemptionCall(address to, address output) internal pure returns (bytes memory) {
        return abi.encodeCall(ISpikoToken.transferAndCall, (to, FUND_AMOUNT, abi.encode(output, SALT)));
    }
}

/// @title  SpikoRoleMainnetTest
/// @notice Mainnet-fork test for `templates/spiko/spiko.tmpl` with `redeem_via: multi_atm`.
///         The fixture grants USDC.transfer to two deposit addresses, and USTBL redemption
///         through the MultiATM. Happy paths per deposit address and for the swap, then
///         rejections: wrong recipient, wrong swap leg, other swap shapes, other selectors and
///         targets, non-member, ETH value, delegatecall.
contract SpikoRoleMainnetTest is SpikoForkBase {
    function fixture() internal pure override returns (string memory) {
        return "spiko.zac.yaml";
    }

    // ============================================================
    // Subscription: transfer(to, value) on USDC, to in {SUBSCRIPTION, SUBSCRIPTION_2}
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
        _reject(USDC, abi.encodeCall(IERC20.transfer, (BOGUS, USDC_AMOUNT)));
    }

    // ============================================================
    // Redemption: USTBL → USDC on the MultiATM, paid to the Safe
    // ============================================================

    /// USTBL leaves the Safe and the previewed USDC lands on it, in the same transaction.
    function test_multiAtm_redeem_happy() public {
        _whitelistSafe();
        deal(USTBL, safeAddr, FUND_AMOUNT);
        uint256 quote = IMultiATM(MULTI_ATM).previewExactInputSingle(USTBL, USDC, FUND_AMOUNT);
        assertGt(quote, 0, "no quote for USTBL/USDC");

        _ok(USTBL, abi.encodeCall(IERC20.approve, (MULTI_ATM, FUND_AMOUNT)));
        _ok(MULTI_ATM, abi.encodeCall(IMultiATM.swapExactInputSingle, (USTBL, USDC, FUND_AMOUNT, safeAddr, quote)));

        assertEq(IERC20(USTBL).balanceOf(safeAddr), 0, "USTBL left on the Safe");
        assertEq(IERC20(USDC).balanceOf(safeAddr), quote, "USDC received differs from the preview");
    }

    /// The ATM pays any recipient it is given: a recipient other than the Safe is rejected.
    function test_swap_recipientNotSafe_rejected() public {
        _reject(MULTI_ATM, abi.encodeCall(IMultiATM.swapExactInputSingle, (USTBL, USDC, FUND_AMOUNT, BOGUS, 0)));
    }

    /// Swapping into another output (USDT) is rejected.
    function test_swap_wrongOutput_rejected() public {
        _reject(MULTI_ATM, abi.encodeCall(IMultiATM.swapExactInputSingle, (USTBL, USDT, FUND_AMOUNT, safeAddr, 0)));
    }

    /// Swapping another input (SAFO, not this config's fund) is rejected.
    function test_swap_wrongInput_rejected() public {
        _reject(MULTI_ATM, abi.encodeCall(IMultiATM.swapExactInputSingle, (SAFO, USDC, FUND_AMOUNT, safeAddr, 0)));
    }

    /// The reverse direction (USDC → USTBL) is rejected.
    function test_swap_reverseDirection_rejected() public {
        _reject(MULTI_ATM, abi.encodeCall(IMultiATM.swapExactInputSingle, (USDC, USTBL, USDC_AMOUNT, safeAddr, 0)));
    }

    /// USTBL can only be approved to the ATM.
    function test_approve_wrongSpender_rejected() public {
        _reject(USTBL, abi.encodeCall(IERC20.approve, (BOGUS, FUND_AMOUNT)));
    }

    // ============================================================
    // Wrong selector or wrong target
    // ============================================================

    /// The exact-output swap is not granted.
    function test_nonAllowed_swapExactOutputSingle_rejected() public {
        _reject(
            MULTI_ATM,
            abi.encodeCall(IMultiATM.swapExactOutputSingle, (USTBL, USDC, USDC_AMOUNT, safeAddr, FUND_AMOUNT))
        );
    }

    /// The multi-hop swap is not granted.
    function test_nonAllowed_swapExactInput_rejected() public {
        address[] memory path = new address[](2);
        path[0] = USTBL;
        path[1] = USDC;
        _reject(MULTI_ATM, abi.encodeCall(IMultiATM.swapExactInput, (path, FUND_AMOUNT, safeAddr, 0)));
    }

    /// USTBL can't leave the Safe by `transfer`.
    function test_nonAllowed_fundTransfer_rejected() public {
        _reject(USTBL, abi.encodeCall(IERC20.transfer, (BOGUS, FUND_AMOUNT)));
    }

    /// The other route, a redemption request on Redemption, is not granted here.
    function test_nonAllowed_redemptionRequest_rejected() public {
        _reject(USTBL, _redemptionCall(REDEMPTION, USDC));
    }

    /// `approve` on USDC is not in the policy. Nothing can pull USDC from the Safe.
    function test_nonAllowed_usdcApprove_rejected() public {
        _reject(USDC, abi.encodeCall(IERC20.approve, (MULTI_ATM, USDC_AMOUNT)));
    }

    /// The same transfer on a token outside the policy (USDT) is rejected.
    function test_nonAllowedTarget_usdtTransfer_rejected() public {
        _reject(USDT, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, USDC_AMOUNT)));
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
                USDC, 0, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, USDC_AMOUNT)), CALL, ROLE_KEY, true
            );
    }

    /// Attaching ETH to an otherwise valid call is rejected (`execution_options: none`).
    function test_sendValue_rejected() public {
        vm.prank(ALICE);
        vm.expectPartialRevert(ROLES_CONDITION_VIOLATION);
        IRoles(modAddr)
            .execTransactionWithRole(
                USDC, 1, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, USDC_AMOUNT)), CALL, ROLE_KEY, true
            );
    }

    /// Delegatecall is rejected (`execution_options: none`).
    function test_delegatecall_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, USDC, abi.encodeCall(IERC20.transfer, (SUBSCRIPTION, USDC_AMOUNT)), DELEGATECALL, ROLE_KEY
        );
    }

    /// Attaching ETH to the swap is rejected (`execution_options: none`).
    function test_sendValue_swap_rejected() public {
        expectPolicyRejectWithValue(
            modAddr,
            ALICE,
            MULTI_ATM,
            1,
            abi.encodeCall(IMultiATM.swapExactInputSingle, (USTBL, USDC, FUND_AMOUNT, safeAddr, 0)),
            CALL,
            ROLE_KEY
        );
    }

    /// Attaching ETH to the USTBL approve is rejected (`execution_options: none`).
    function test_sendValue_approve_rejected() public {
        expectPolicyRejectWithValue(
            modAddr, ALICE, USTBL, 1, abi.encodeCall(IERC20.approve, (MULTI_ATM, FUND_AMOUNT)), CALL, ROLE_KEY
        );
    }

    /// Delegatecall into USTBL is rejected (`execution_options: none`).
    function test_delegatecall_approve_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, USTBL, abi.encodeCall(IERC20.approve, (MULTI_ATM, FUND_AMOUNT)), DELEGATECALL, ROLE_KEY
        );
    }

    /// Delegatecall into the ATM is rejected too.
    function test_delegatecall_swap_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            MULTI_ATM,
            abi.encodeCall(IMultiATM.swapExactInputSingle, (USTBL, USDC, FUND_AMOUNT, safeAddr, 0)),
            DELEGATECALL,
            ROLE_KEY
        );
    }
}

/// @title  SpikoRedemptionRequestRoleMainnetTest
/// @notice Mainnet-fork test for `templates/spiko/spiko.tmpl` with
///         `redeem_via: redemption_request`. The fixture grants USDC.transfer to one deposit
///         address, and SAFO redemption through a request on Spiko's Redemption contract.
///         Happy path: the request opens in the Safe's name, and a request left unexecuted
///         returns the SAFO to the Safe. Then rejections: wrong receiver, fiat or other
///         output, the no-data overload, other selectors and targets, ETH value, delegatecall.
contract SpikoRedemptionRequestRoleMainnetTest is SpikoForkBase {
    uint8 constant PENDING = 1;
    uint8 constant CANCELED = 3;

    function fixture() internal pure override returns (string memory) {
        return "spiko_redemption_request.zac.yaml";
    }

    /// The subscription leg is unchanged on this route.
    function test_transfer_happy() public {
        _transferOk(SUBSCRIPTION);
    }

    // ============================================================
    // Redemption: SAFO → USDC request on Redemption, opened in the Safe's name
    // ============================================================

    /// SAFO moves to Redemption and a pending request exists for (Safe, SAFO, USDC, amount, salt).
    function test_redemptionRequest_happy() public {
        bytes32 id = _openRequest();
        (uint8 status,) = ISpikoRedemption(REDEMPTION).details(id);
        assertEq(status, PENDING, "request not pending");
    }

    /// Spiko leaves the request unexecuted for 14 days: anyone cancels it and the SAFO comes back to the Safe.
    function test_redemptionRequest_cancelReturnsToSafe() public {
        bytes32 id = _openRequest();
        (, uint48 deadline) = ISpikoRedemption(REDEMPTION).details(id);
        vm.warp(deadline);

        vm.prank(BOGUS);
        ISpikoRedemption(REDEMPTION).cancelRedemption(safeAddr, SAFO, USDC, FUND_AMOUNT, SALT);

        (uint8 status,) = ISpikoRedemption(REDEMPTION).details(id);
        assertEq(status, CANCELED, "request not canceled");
        assertEq(IERC20(SAFO).balanceOf(safeAddr), FUND_AMOUNT, "SAFO not returned to the Safe");
    }

    /// SAFO sent with a request to any receiver other than Redemption is rejected.
    function test_redemptionRequest_wrongReceiver_rejected() public {
        _reject(SAFO, _redemptionCall(BOGUS, USDC));
    }

    /// A fiat request (output = zero address) is rejected: its payout leaves the chain.
    function test_redemptionRequest_fiatOutput_rejected() public {
        _reject(SAFO, _redemptionCall(REDEMPTION, address(0)));
    }

    /// A request into another output (USDT) is rejected.
    function test_redemptionRequest_otherOutput_rejected() public {
        _reject(SAFO, _redemptionCall(REDEMPTION, USDT));
    }

    // ============================================================
    // Wrong selector or wrong target
    // ============================================================

    /// The ERC-1363 overload without `data` is not granted.
    function test_nonAllowed_transferAndCallNoData_rejected() public {
        _reject(SAFO, abi.encodeCall(ISpikoTokenNoData.transferAndCall, (REDEMPTION, FUND_AMOUNT)));
    }

    /// SAFO can't leave the Safe by `transfer`, even to Redemption.
    function test_nonAllowed_fundTransfer_rejected() public {
        _reject(SAFO, abi.encodeCall(IERC20.transfer, (REDEMPTION, FUND_AMOUNT)));
    }

    /// The other route is not granted here: no approve to the ATM, no swap.
    function test_nonAllowed_multiAtm_rejected() public {
        _reject(SAFO, abi.encodeCall(IERC20.approve, (MULTI_ATM, FUND_AMOUNT)));
        _reject(MULTI_ATM, abi.encodeCall(IMultiATM.swapExactInputSingle, (SAFO, USDC, FUND_AMOUNT, safeAddr, 0)));
    }

    /// The same request on another fund (USTBL) is rejected.
    function test_nonAllowedTarget_otherFund_rejected() public {
        _reject(USTBL, _redemptionCall(REDEMPTION, USDC));
    }

    /// Attaching ETH to the request is rejected (`execution_options: none`).
    function test_sendValue_redemptionRequest_rejected() public {
        expectPolicyRejectWithValue(modAddr, ALICE, SAFO, 1, _redemptionCall(REDEMPTION, USDC), CALL, ROLE_KEY);
    }

    /// Delegatecall into the fund token is rejected (`execution_options: none`).
    function test_delegatecall_redemptionRequest_rejected() public {
        expectPolicyReject(modAddr, ALICE, SAFO, _redemptionCall(REDEMPTION, USDC), DELEGATECALL, ROLE_KEY);
    }

    /// @dev Fund the Safe with SAFO, open a request through the role, check the SAFO moved,
    ///      and return the request id.
    function _openRequest() internal returns (bytes32 id) {
        _whitelistSafe();
        deal(SAFO, safeAddr, FUND_AMOUNT);
        uint256 before = IERC20(SAFO).balanceOf(REDEMPTION);

        _ok(SAFO, _redemptionCall(REDEMPTION, USDC));

        assertEq(IERC20(SAFO).balanceOf(safeAddr), 0, "SAFO left on the Safe");
        assertEq(IERC20(SAFO).balanceOf(REDEMPTION) - before, FUND_AMOUNT, "SAFO did not reach Redemption");
        id = ISpikoRedemption(REDEMPTION).hashRedemptionId(safeAddr, SAFO, USDC, FUND_AMOUNT, SALT);
    }
}
