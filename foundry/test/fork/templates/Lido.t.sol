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

interface IWithdrawalQueue {
    function requestWithdrawalsWstETH(uint256[] calldata amounts, address owner) external returns (uint256[] memory);
    function claimWithdrawals(uint256[] calldata requestIds, uint256[] calldata hints) external;
    function claimWithdrawalsTo(uint256[] calldata requestIds, uint256[] calldata hints, address recipient) external;
    function finalize(uint256 lastRequestIdToBeFinalized, uint256 maxShareRate) external payable;
    function prefinalize(uint256[] calldata batches, uint256 maxShareRate)
        external
        view
        returns (uint256 ethToLock, uint256 sharesToBurn);
    function findCheckpointHints(uint256[] calldata requestIds, uint256 firstIndex, uint256 lastIndex)
        external
        view
        returns (uint256[] memory);
    function getLastCheckpointIndex() external view returns (uint256);
    function getLastRequestId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IStETHRate {
    function getPooledEthByShares(uint256 shares) external view returns (uint256);
}

interface IWETHDeposit {
    function deposit() external payable;
}

/// @title  LidoExitRoleMainnetTest
/// @notice Mainnet-fork acceptance test for `lido.tmpl` with `exit: true`.
/// @dev    Sibling of {LidoRoleMainnetTest}: that suite applies the default fixture and so
///         pins what the template emits with the gate CLOSED, this one applies
///         `lido_exit.zac.yaml` and pins what the gate adds. The happy path drives a real
///         round trip — approve, request, finalise, claim, re-wrap — rather than stopping at
///         the gate, because the point of the leg is that the four grants compose into an
///         exit the Safe can complete alone. Finalisation is Lido's own role-gated call, so
///         the test impersonates the stETH contract (the live FINALIZE_ROLE holder) to stand
///         in for the oracle report that would do it in production.
contract LidoExitRoleMainnetTest is ZacForkTest {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant STETH = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address constant QUEUE = 0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant ATTACKER = 0x2222222222222222222222222222222222222222;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;

    /// @dev Policy-pinned values (mirror `lido_exit.zac.yaml` + the template).
    uint256 constant MAX_EXIT_APPROVAL = 50 ether;

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

        applyConfigFile(fx, ALICE, "lido_exit.zac.yaml");

        // The exit leg starts from collateral already held as wstETH; acquiring it is the
        // mint leg's concern (or a swap venue's), so seed the balance directly.
        deal(WSTETH, safeAddr, ROUND);
    }

    // ==================== Acceptance: allow ====================

    /// TX-1 — happy: the full exit. Approve the queue, request the withdrawal, let Lido
    ///        finalise it, claim the ETH and wrap it back to WETH, every call through the
    ///        gate. The assertions track the position across the three forms it takes —
    ///        wstETH, then an NFT with no balance behind it, then ETH, then WETH — which is
    ///        the property that makes this leg a NAV question and not just a policy one.
    function test_TX1_RoleMemberCanCompleteTheExit() public {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = ROUND;

        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(WSTETH, 0, abi.encodeCall(IERC20.approve, (QUEUE, ROUND)), CALL, ROLE_KEY, true);

        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                QUEUE,
                0,
                abi.encodeCall(IWithdrawalQueue.requestWithdrawalsWstETH, (amounts, safeAddr)),
                CALL,
                ROLE_KEY,
                true
            );

        uint256 requestId = IWithdrawalQueue(QUEUE).getLastRequestId();
        assertEq(IWithdrawalQueue(QUEUE).ownerOf(requestId), safeAddr, "claim NFT not minted to the Safe");
        assertEq(IERC20(WSTETH).balanceOf(safeAddr), 0, "wstETH was not burned by the request");

        // Stand in for the oracle report that finalises the queue in production. The stETH
        // contract is the live FINALIZE_ROLE holder, so impersonating it is the narrowest
        // way to reach the state a claim needs.
        uint256[] memory batches = new uint256[](1);
        batches[0] = requestId;
        uint256 shareRate = IStETHRate(STETH).getPooledEthByShares(1e27);
        (uint256 ethToLock,) = IWithdrawalQueue(QUEUE).prefinalize(batches, shareRate);
        vm.deal(STETH, ethToLock);
        vm.prank(STETH);
        IWithdrawalQueue(QUEUE).finalize{value: ethToLock}(requestId, shareRate);

        uint256[] memory ids = new uint256[](1);
        ids[0] = requestId;
        uint256[] memory hints =
            IWithdrawalQueue(QUEUE).findCheckpointHints(ids, 1, IWithdrawalQueue(QUEUE).getLastCheckpointIndex());

        uint256 ethBefore = safeAddr.balance;
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                QUEUE, 0, abi.encodeCall(IWithdrawalQueue.claimWithdrawals, (ids, hints)), CALL, ROLE_KEY, true
            );
        uint256 claimed = safeAddr.balance - ethBefore;
        assertGt(claimed, 0, "claim did not deliver ETH to the Safe");

        // The claim pays native ETH, which nothing downstream of this Safe takes; `deposit`
        // is what closes the loop back to the WETH the strategy is denominated in.
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(WETH, claimed, abi.encodeCall(IWETHDeposit.deposit, ()), CALL, ROLE_KEY, true);
        assertEq(IERC20(WETH).balanceOf(safeAddr), claimed, "ETH was not wrapped back to WETH");
    }

    /// TX-2 — an approve below the exit ceiling clears the gate, and the ceiling is its own:
    ///        `max_exit_approval` (50e18) is deliberately lower than `max_approval` (100e18),
    ///        so an amount between the two proves the wstETH approve is not reading the
    ///        wrapper's bound.
    function test_TX2_ExitApprovalHasItsOwnCeiling() public {
        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(
                WSTETH, 0, abi.encodeCall(IERC20.approve, (QUEUE, MAX_EXIT_APPROVAL - 1)), CALL, ROLE_KEY, true
            );
        assertEq(IERC20(WSTETH).allowance(safeAddr, QUEUE), MAX_EXIT_APPROVAL - 1, "allowance did not update");

        expectPolicyReject(
            modAddr, ALICE, WSTETH, abi.encodeCall(IERC20.approve, (QUEUE, MAX_EXIT_APPROVAL + 1)), CALL, ROLE_KEY
        );
    }

    // ==================== Acceptance: deny ====================

    /// TX-3 — the owner is pinned to the avatar. This is the whole containment argument for
    ///        the leg: the claim NFT carries the right to the ETH, so a request naming any
    ///        other owner would hand the position out of the Safe in one call.
    function test_TX3_ForeignWithdrawalOwnerRejected() public {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = ROUND;
        expectPolicyReject(
            modAddr,
            ALICE,
            QUEUE,
            abi.encodeCall(IWithdrawalQueue.requestWithdrawalsWstETH, (amounts, ATTACKER)),
            CALL,
            ROLE_KEY
        );
    }

    /// TX-4 — `claimWithdrawalsTo` is deliberately unscoped. `claimWithdrawals` pays the
    ///        owner, which TX-3 has already pinned, so this is the one call that would let a
    ///        role member route the proceeds off the Safe without ever failing a parameter
    ///        check. Asserted rather than left to the absence of a grant.
    function test_TX4_ClaimToForeignRecipientRejected() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory hints = new uint256[](1);
        hints[0] = 1;
        expectPolicyReject(
            modAddr,
            ALICE,
            QUEUE,
            abi.encodeCall(IWithdrawalQueue.claimWithdrawalsTo, (ids, hints, ATTACKER)),
            CALL,
            ROLE_KEY
        );
    }

    /// TX-5 — `unwrap` stays out of scope even with the exit leg on: the queue takes wstETH
    ///        directly, so the exit path is wstETH-in / ETH-out and never needs raw stETH.
    ///        This is the assertion that keeps `exit: true` from being read as "the reverse
    ///        direction is now open".
    function test_TX5_UnwrapStillRejected() public {
        expectPolicyReject(modAddr, ALICE, WSTETH, abi.encodeCall(IWstETH.unwrap, (ROUND)), CALL, ROLE_KEY);
    }

    /// TX-6 — `deposit` is the only exit-leg call granted `send`; the queue calls are granted
    ///        `none`, so attaching value to a request must be refused even though the target
    ///        is otherwise reachable.
    function test_TX6_ValueOnRequestRejected() public {
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = ROUND;
        expectPolicyRejectWithValue(
            modAddr,
            ALICE,
            QUEUE,
            ROUND,
            abi.encodeCall(IWithdrawalQueue.requestWithdrawalsWstETH, (amounts, safeAddr)),
            CALL,
            ROLE_KEY
        );
    }

    /// TX-7 — the operation is `Call` on the queue too, so a delegatecall to it is refused.
    ///        Worth pinning on this target specifically: the queue holds the ETH backing
    ///        every pending claim, so its code running in the Safe's storage is the worst
    ///        available pairing on this leg.
    function test_TX7_DelegatecallToQueueRejected() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory hints = new uint256[](1);
        hints[0] = 1;
        expectPolicyReject(
            modAddr,
            ALICE,
            QUEUE,
            abi.encodeCall(IWithdrawalQueue.claimWithdrawals, (ids, hints)),
            DELEGATECALL,
            ROLE_KEY
        );
    }
}
