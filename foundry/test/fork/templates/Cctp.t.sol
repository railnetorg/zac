// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

/// @dev Minimal ERC20 surface used by the assertions.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  CctpRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/cctp/cctp.tmpl` policy —
///         the source side of an Ethereum → Base USDC bridge over Circle CCTP v2.
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `cctp.zac.yaml` fixture against the fresh Modifier.
///         `MAINNET_RPC_URL` must be set.
///
///         Scope is the burn on the home Safe only: `approve(USDC → TokenMessengerV2)`
///         and `depositForBurn(... → Base / destination Safe / USDC / standard finality)`.
///         The Base mint is permissionless (a keeper relays Circle's attestation) and is
///         out of Roles scope — not exercised here.
///
///         The burn happy-path (TF-3) uses `shouldRevert=true` and asserts the Safe's
///         USDC balance drops by the bridged amount: unlike Milkman, the CCTP burn runs
///         to completion on a fork (no off-chain dependency), so this proves the policy
///         authorised a real, executing bridge. Deny cases use `expectPolicyReject`: a
///         gate rejection reverts with `ConditionViolation` regardless of inner state.
///
///         The load-bearing pins are mintRecipient (funds can only land in the
///         destination Safe), burnToken (USDC only) and destinationDomain (Base only) —
///         the CCTP analogue of Milkman's pinned recipient.
contract CctpRoleMainnetTest is ZacForkTest {
    // CCTP v2 + token addresses referenced by the policy + assertions.
    address constant TOKEN_MESSENGER = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7; // wrong burnToken

    // Destination (Base) parameters the policy pins — must match cctp.zac.yaml.
    address constant BASE_SAFE = 0x4B6F1D37D2561C71355E5b63dBFfAaf372D30Da3;
    uint32 constant BASE_DOMAIN = 6;
    uint32 constant STANDARD_THRESHOLD = 2000;
    uint32 constant FAST_THRESHOLD = 1000; // not permitted by the policy

    // mintRecipient = bytes32(uint160(BASE_SAFE)) — the address right-aligned in a word.
    bytes32 constant MINT_RECIPIENT = 0x0000000000000000000000004B6F1D37D2561C71355E5b63dBFfAaf372D30Da3;
    bytes32 constant ZERO_CALLER = bytes32(0);

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant NOT_MESSENGER = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint256 constant AMOUNT = 1_000e6;
    uint256 constant MAX_FEE = 0; // Standard transfer: fee is 0

    /// @dev `encodeKey('STRATEGY_MANAGER')` — right-padded ASCII bytes32. Bridging is a
    ///      treasury-movement operation under the same role as CowSwap swaps.
    bytes32 constant ROLE_KEY = 0x53545241544547595f4d414e4147455200000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "cctp.zac.yaml");
    }

    // ==================== approve: spender == TokenMessengerV2, amount pass ====================

    /// TF-1 — allow: approve USDC to the messenger for a normal amount; allowance is set.
    function test_TF1_ApproveMessengerAllowed() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(USDC, 0, _approveCd(TOKEN_MESSENGER, AMOUNT), CALL, ROLE_KEY, true);
        assertEq(IERC20(USDC).allowance(safeAddr, TOKEN_MESSENGER), AMOUNT, "allowance not set");
    }

    /// TF-2 — allow: amount is `pass`, so even an unlimited approval clears the gate. The
    ///        messenger only ever pulls the exact burn amount, so the amount is not bounded.
    function test_TF2_ApproveUnlimitedAllowed() public {
        uint256 amt = type(uint256).max;
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(USDC, 0, _approveCd(TOKEN_MESSENGER, amt), CALL, ROLE_KEY, true);
        assertEq(IERC20(USDC).allowance(safeAddr, TOKEN_MESSENGER), amt, "allowance not set");
    }

    // ==================== depositForBurn: the pinned bridge ====================

    /// TF-3 — allow + execute: a burn to Base / destination Safe / USDC / standard finality
    ///        clears the gate AND runs to completion — the Safe's USDC balance drops by the
    ///        bridged amount. `shouldRevert=true`, so a gate rejection OR an inner failure
    ///        would revert; a clean run with the balance drop proves the bridge executed.
    function test_TF3_DepositForBurnAllowed_Executes() public {
        deal(USDC, safeAddr, AMOUNT);

        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(USDC, 0, _approveCd(TOKEN_MESSENGER, AMOUNT), CALL, ROLE_KEY, true);

        uint256 balBefore = IERC20(USDC).balanceOf(safeAddr);
        bytes memory cd = _burn(AMOUNT, BASE_DOMAIN, MINT_RECIPIENT, USDC, ZERO_CALLER, MAX_FEE, STANDARD_THRESHOLD);

        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(TOKEN_MESSENGER, 0, cd, CALL, ROLE_KEY, true);

        assertEq(IERC20(USDC).balanceOf(safeAddr), balBefore - AMOUNT, "USDC not burned");
    }

    // ==================== approve red-team / scope ====================

    /// TF-4 — deny: approving any spender other than the messenger breaches `equal_to`.
    function test_TF4_ApproveWrongSpenderRejected() public {
        _expectReject(USDC, _approveCd(NOT_MESSENGER, AMOUNT));
    }

    /// TF-5 — deny: approve is scoped on USDC only. Approving a different token (USDT) to
    ///        the messenger hits no permission and is rejected.
    function test_TF5_ApproveUnlistedTokenRejected() public {
        _expectReject(USDT, _approveCd(TOKEN_MESSENGER, AMOUNT));
    }

    // ==================== depositForBurn red-team ====================

    /// TF-6 — deny: destinationDomain must be Base (6); any other domain is rejected.
    function test_TF6_BurnWrongDomainRejected() public {
        bytes memory cd = _burn(AMOUNT, 0, MINT_RECIPIENT, USDC, ZERO_CALLER, MAX_FEE, STANDARD_THRESHOLD);
        _expectReject(TOKEN_MESSENGER, cd);
    }

    /// TF-7 — deny: mintRecipient is pinned to the destination Safe — the load-bearing
    ///        redirect guard. A different recipient (ALICE) is rejected.
    function test_TF7_BurnWrongRecipientRejected() public {
        bytes32 wrong = bytes32(uint256(uint160(ALICE)));
        bytes memory cd = _burn(AMOUNT, BASE_DOMAIN, wrong, USDC, ZERO_CALLER, MAX_FEE, STANDARD_THRESHOLD);
        _expectReject(TOKEN_MESSENGER, cd);
    }

    /// TF-8 — deny: mintRecipient == 0 (burn-to-nowhere) is not the pinned Safe; rejected.
    function test_TF8_BurnZeroRecipientRejected() public {
        bytes memory cd = _burn(AMOUNT, BASE_DOMAIN, bytes32(0), USDC, ZERO_CALLER, MAX_FEE, STANDARD_THRESHOLD);
        _expectReject(TOKEN_MESSENGER, cd);
    }

    /// TF-9 — deny: burnToken is pinned to USDC; a different token (USDT) is rejected.
    function test_TF9_BurnWrongBurnTokenRejected() public {
        bytes memory cd = _burn(AMOUNT, BASE_DOMAIN, MINT_RECIPIENT, USDT, ZERO_CALLER, MAX_FEE, STANDARD_THRESHOLD);
        _expectReject(TOKEN_MESSENGER, cd);
    }

    /// TF-10 — deny: destinationCaller is pinned to bytes32(0) (permissionless mint). A
    ///         non-zero caller would gate the destination mint to one address; rejected.
    function test_TF10_BurnNonZeroCallerRejected() public {
        bytes32 caller = bytes32(uint256(uint160(ALICE)));
        bytes memory cd = _burn(AMOUNT, BASE_DOMAIN, MINT_RECIPIENT, USDC, caller, MAX_FEE, STANDARD_THRESHOLD);
        _expectReject(TOKEN_MESSENGER, cd);
    }

    /// TF-11 — deny: minFinalityThreshold is pinned to 2000 (Standard / finalized). A Fast
    ///         transfer (1000) is rejected — the policy permits Standard only.
    function test_TF11_BurnFastFinalityRejected() public {
        bytes memory cd = _burn(AMOUNT, BASE_DOMAIN, MINT_RECIPIENT, USDC, ZERO_CALLER, MAX_FEE, FAST_THRESHOLD);
        _expectReject(TOKEN_MESSENGER, cd);
    }

    // ==================== scope boundary: only depositForBurn is scoped ====================

    /// TF-12 — deny: only depositForBurn is scoped on the messenger. The hook variant
    ///         (depositForBurnWithHook, a different selector) is not authorised, so it
    ///         cannot be used to attach arbitrary destination-side hook calldata.
    function test_TF12_DepositForBurnWithHookRejected() public {
        bytes memory cd = abi.encodeWithSignature(
            "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
            AMOUNT,
            BASE_DOMAIN,
            MINT_RECIPIENT,
            USDC,
            ZERO_CALLER,
            MAX_FEE,
            STANDARD_THRESHOLD,
            bytes("")
        );
        _expectReject(TOKEN_MESSENGER, cd);
    }

    // ==================== Helpers ====================

    /// @dev Assert `ALICE`'s `execTransactionWithRole(to, 0, data, CALL)` is rejected at the
    ///      policy gate (reverts with `ConditionViolation`).
    function _expectReject(address to, bytes memory data) internal {
        expectPolicyReject(modAddr, ALICE, to, data, CALL, ROLE_KEY);
    }

    function _approveCd(address spender, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(IERC20.approve, (spender, amount));
    }

    /// @dev depositForBurn v2 calldata (selector 0x8e0250ee).
    function _burn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) internal pure returns (bytes memory) {
        return abi.encodeWithSignature(
            "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
            amount,
            destinationDomain,
            mintRecipient,
            burnToken,
            destinationCaller,
            maxFee,
            minFinalityThreshold
        );
    }
}
