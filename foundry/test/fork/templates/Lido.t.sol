// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETH {
    function withdraw(uint256 amount) external;
}

interface ILido {
    function submit(address referral) external payable returns (uint256);
}

interface IWstETH {
    function wrap(uint256 amount) external returns (uint256);
    function unwrap(uint256 amount) external returns (uint256);
}

/// @title  LidoRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/lido/lido.tmpl` policy.
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `lido.zac.yaml` fixture against the fresh Modifier. The
///         happy path walks the whole mint leg — WETH → ETH → stETH → wstETH — through the
///         gate, so the four scoped calls are asserted in the order a leverage round uses
///         them. `MAINNET_RPC_URL` must be set.
contract LidoRoleMainnetTest is ZacForkTest {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant ATTACKER = 0x2222222222222222222222222222222222222222;
    uint8 constant CALL = 0;

    /// @dev Policy-pinned values (mirror `lido.zac.yaml` + the template).
    address constant NO_REFERRAL = address(0);
    uint256 constant MAX_APPROVAL = 100 ether;

    uint256 constant ROUND = 1 ether;

    /// @dev `encodeKey('LIDO')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x4c49444f00000000000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "lido.zac.yaml");

        // The mint leg starts from borrowed WETH; the borrow itself is the aave_v3 policy's
        // concern, so seed the balance directly.
        deal(WETH, safeAddr, ROUND);
    }

    // ==================== Acceptance: allow ====================

    /// TF-1 — happy: the full round. Unwrap WETH to ETH, submit it to Lido, approve the
    ///        wrapper and wrap the resulting stETH. Each leg goes through the gate as a
    ///        separate role call, which is how the keeper drives it: Roles has no MultiSend
    ///        unwrapper here, so a member submits one call per transaction.
    function test_TF1_RoleMemberCanRunTheFullMintRound() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(WETH, 0, abi.encodeCall(IWETH.withdraw, (ROUND)), CALL, ROLE_KEY, true);
        assertEq(safeAddr.balance, ROUND, "unwrap did not credit the Safe with ETH");

        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(STETH, ROUND, abi.encodeCall(ILido.submit, (NO_REFERRAL)), CALL, ROLE_KEY, true);
        uint256 minted = IERC20(STETH).balanceOf(safeAddr);
        assertGt(minted, 0, "submit did not mint stETH to the Safe");

        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(STETH, 0, abi.encodeCall(IERC20.approve, (WSTETH, minted)), CALL, ROLE_KEY, true);
        assertEq(IERC20(STETH).allowance(safeAddr, WSTETH), minted, "Safe -> wrapper allowance did not update");

        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(WSTETH, 0, abi.encodeCall(IWstETH.wrap, (minted)), CALL, ROLE_KEY, true);
        assertGt(IERC20(WSTETH).balanceOf(safeAddr), 0, "wrap did not credit the Safe with wstETH");
    }

    /// TF-2 — happy: an approve below the configured ceiling clears the gate.
    function test_TF2_RoleMemberCanApproveWrapperUnderCap() public {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                STETH, 0, abi.encodeCall(IERC20.approve, (WSTETH, MAX_APPROVAL - 1)), CALL, ROLE_KEY, true
            );
        assertEq(IERC20(STETH).allowance(safeAddr, WSTETH), MAX_APPROVAL - 1, "allowance did not update");
    }

    // ==================== Acceptance: deny ====================

    /// TF-3 — the referral is pinned: naming any other address is rejected. Value is 0 here,
    ///        which would make Lido revert `ZERO_DEPOSIT` on execution — the gate rejects
    ///        first, so a `ConditionViolation` is what proves the parameter is enforced.
    function test_TF3_NonZeroReferralRejected() public {
        expectPolicyReject(modAddr, ALICE, STETH, abi.encodeCall(ILido.submit, (ATTACKER)), CALL, ROLE_KEY);
    }

    /// TF-4 — the approve spender is pinned to the wrapper; any other spender is rejected.
    function test_TF4_ApproveForeignSpenderRejected() public {
        expectPolicyReject(modAddr, ALICE, STETH, abi.encodeCall(IERC20.approve, (ATTACKER, ROUND)), CALL, ROLE_KEY);
    }

    /// TF-5 — the ceiling is exclusive (`less_than`), so an approve for exactly the
    ///        configured value is rejected, not just one above it.
    function test_TF5_ApproveAtCapRejected() public {
        expectPolicyReject(
            modAddr, ALICE, STETH, abi.encodeCall(IERC20.approve, (WSTETH, MAX_APPROVAL)), CALL, ROLE_KEY
        );
    }

    /// TF-6 — the reverse direction is deliberately out of scope: exits go through a swap
    ///        venue, scoped by its own template. `unwrap` is not in the policy, so the
    ///        Modifier refuses it. The revert is asserted generically rather than by
    ///        selector: the Roles bytecode is fetched from the fork, not vendored, so the
    ///        exact status this raises for an unscoped function is not verifiable here.
    function test_TF6_UnwrapRejected() public {
        vm.prank(ALICE);
        vm.expectRevert();
        IRoles(modAddr)
            .execTransactionWithRole(WSTETH, 0, abi.encodeCall(IWstETH.unwrap, (ROUND)), CALL, ROLE_KEY, false);
    }
}
