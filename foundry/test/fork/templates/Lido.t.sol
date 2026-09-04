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
    uint8 constant DELEGATECALL = 1;

    /// @dev Policy-pinned values (mirror `lido.zac.yaml` + the template).
    address constant NO_REFERRAL = address(0);
    uint256 constant MAX_APPROVAL = 100 ether;

    uint256 constant ROUND = 1 ether;

    /// @dev Matches `encodeKey('LIDO')` — right-padded ASCII bytes32.
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
    ///        Modifier refuses it at the gate. Roles V2 funnels its rejections through
    ///        `ConditionViolation`, so an unscoped selector is asserted the same way as a
    ///        violated parameter.
    function test_TF6_UnwrapRejected() public {
        expectPolicyReject(modAddr, ALICE, WSTETH, abi.encodeCall(IWstETH.unwrap, (ROUND)), CALL, ROLE_KEY);
    }

    /// TF-7 — `send` is granted per function, not per target. `approve` sits on the same
    ///        target as `submit` and is granted `none`, so attaching value to it must be
    ///        refused. This is the case that would catch a regression in how execution
    ///        options are keyed, since stETH is the only target carrying both.
    function test_TF7_ValueOnApproveRejected() public {
        expectPolicyRejectWithValue(
            modAddr, ALICE, STETH, ROUND, abi.encodeCall(IERC20.approve, (WSTETH, ROUND)), CALL, ROLE_KEY
        );
    }

    /// TF-8 — the same property across targets: `wrap` is on a different contract and is
    ///        granted `none`, so value attached to it is refused too.
    function test_TF8_ValueOnWrapRejected() public {
        expectPolicyRejectWithValue(
            modAddr, ALICE, WSTETH, ROUND, abi.encodeCall(IWstETH.wrap, (ROUND)), CALL, ROLE_KEY
        );
    }

    /// TF-9 — a bare value transfer to stETH, with no calldata at all, is not reachable.
    ///        This one carries weight: stETH's own receive path stakes, so if empty calldata
    ///        were admitted under this role the pinned referral would be bypassable by
    ///        sending ETH with no calldata. Empty calldata is not a scoped selector, so the
    ///        Modifier refuses it — asserted here rather than left to be re-derived.
    function test_TF9_BareEthTransferToStethRejected() public {
        expectPolicyRejectWithValue(modAddr, ALICE, STETH, ROUND, bytes(""), CALL, ROLE_KEY);
    }

    /// TF-10 — the operation is `Call` on every scoped function, so a delegatecall is refused
    ///         even on a target the role is otherwise allowed to reach. Asserted on stETH
    ///         because that is the target carrying `send`: a delegatecall there would run
    ///         stETH's code in the Safe's own storage while the role is also permitted to
    ///         attach ETH, which is the worst pairing available under this policy.
    function test_TF10_DelegatecallToStethRejected() public {
        expectPolicyReject(modAddr, ALICE, STETH, abi.encodeCall(ILido.submit, (NO_REFERRAL)), DELEGATECALL, ROLE_KEY);
    }

    /// TF-11 — the same on a plain `none` target, so the property is pinned as policy-wide
    ///         rather than a peculiarity of the one function granted `send`. Neither of these
    ///         should ever be reachable; they exist so an upstream change to how execution
    ///         options are derived breaks a test rather than widening the policy quietly.
    function test_TF11_DelegatecallToWstethRejected() public {
        expectPolicyReject(modAddr, ALICE, WSTETH, abi.encodeCall(IWstETH.wrap, (ROUND)), DELEGATECALL, ROLE_KEY);
    }
}
