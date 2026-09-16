// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Claim-side surface of the Merkl Distributor. `claim` is the one function the policy
///      grants; the block below it are real distributor functions deliberately left OUT of
///      the policy (used as negative cases).
interface IMerklDistributor {
    function claim(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external;
    // Not in policy:
    function claimWithRecipient(
        address[] calldata users,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs,
        address[] calldata recipients,
        bytes[] calldata datas
    ) external;
    function setClaimRecipient(address recipient, address token) external;
    function toggleOperator(address user, address operator) external;
    function recoverERC20(address tokenAddress, address to, uint256 amountToRecover) external;
    // Views used by the replay test.
    function claimed(address user, address token)
        external
        view
        returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot);
}

/// @title  MerklRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/merkl/merkl.tmpl` policy, driven by
///         the shared `ZacForkTest` harness.
/// @dev    The fork is PINNED to the block before a real mainnet claim
///         (0xb30705c45116afa8f414d920347ccd2c558b75c218d3388811c846e1f5f538fb, block
///         25976351), and the happy path replays that transaction's EXACT calldata through
///         the modifier — a genuine Merkle proof verified against the live root, rather than
///         a fabricated tree. The claim settles for a third-party user, which makes the
///         template's safety argument executable twice over: the distributor only accepts the
///         call because the user pre-approved the Safe as an operator (staged outside the
///         policy, like Wildcat's lender authorisation), and the payout still routes to the
///         user — nothing reaches the Safe. Without that approval the SAME calldata reverts
///         `NotWhitelisted()`: the Safe cannot even claim for strangers, let alone redirect.
///
///         Allowed calls (policy):
///           DISTRIBUTOR.claim(users=pass, tokens=pass, amounts=pass, proofs=pass)
///
///         The `users` array cannot be pinned to the avatar — zac's DSL has no array
///         param_type (see the template header). The negative block below is therefore the
///         entire enforcement story: the redirection vectors (`claimWithRecipient`,
///         `setClaimRecipient`, `toggleOperator`) must be rejected, or the unscoped `users`
///         WOULD become exploitable.
contract MerklRoleMainnetTest is ZacForkTest {
    /// Canonical Merkl Distributor (aliases.merkl.distributor).
    address constant DISTRIBUTOR = 0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae;

    /// The block BEFORE the replayed claim's inclusion block — proofs are valid and unclaimed.
    uint256 constant PIN_BLOCK = 25976350;

    /// The replayed claim's beneficiary (a third party, NOT the Safe) and its three tokens,
    /// with the CUMULATIVE amounts carried by the proof (Merkl trees track lifetime totals).
    address constant USER = 0x00c04AE980A41825FCb505797d394090295B5813;
    address constant TOKEN_A = 0x365AccFCa291e7D3914637ABf1F7635dB165Bb09;
    address constant PENDLE = 0x808507121B80c02388fAd14726482e061B8da827;
    address constant TOKEN_C = 0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD;
    uint208 constant CUM_A = 3576022901820325131;
    uint208 constant CUM_PENDLE = 2117288363632635054578;
    uint208 constant CUM_C = 16029360346224751837013;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    uint8 constant CALL = 0;
    uint8 constant DELEGATECALL = 1;

    /// @dev `encodeKey('MERKL')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x4d45524b4c000000000000000000000000000000000000000000000000000000;

    /// @dev The verbatim calldata of the replayed mainnet claim (selector 0x71ee95c0).
    bytes constant CLAIM_CALLDATA =
        hex"71ee95c00000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000c04ae980a41825fcb505797d394090295b581300000000000000000000000000c04ae980a41825fcb505797d394090295b581300000000000000000000000000c04ae980a41825fcb505797d394090295b58130000000000000000000000000000000000000000000000000000000000000003000000000000000000000000365accfca291e7d3914637abf1f7635db165bb09000000000000000000000000808507121b80c02388fad14726482e061b8da8270000000000000000000000008292bb45bf1ee4d140127049757c2e0ff06317ed000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000031a095e1f3a97d0b000000000000000000000000000000000000000000000072c74754d96f4e89f2000000000000000000000000000000000000000000000364f40fc3b352d07f5500000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000005a00000000000000000000000000000000000000000000000000000000000000014891d79fea13ff1ff00112009db63d0e8d3b4a052e3c0dffc5545183f607e7adf0715bc788811b9f5988f29c0e13849ff51dc0d919016c1a400d441739758a88a64227157c1028dceeaa25e4304c2bb233e6ce9c9c5d96b66192f85ce0039fc05022727eac02f1fbc0eef2d5af810f55088ea09705f413caec1d8832f8d2d067e8f0a66b041a8169fa0f71e8df35aafd50c4b0355d53394b6a5531ca0048e60340d9e72d04cc4182b76743a70cc8613b7bbb1d5de189e610e4bba36f2f03736ba1a6f91017fd855f58588f3129d78d85c64d6d5bb10fadc527909755c01ee1f33a300f7f09d7cbe5af5a50ba599762676e1e8d94f067a621f875c6df9cfcb9bc080f2a2eb37dff804fc642cb81185232fac2a1282686533e3a477f700a377a8d20517dda2062a02c94ca05c7513540352353a6e13ea44c18e32fc8e6cdc2a3c776a713f207bc7ba8855c8249a07fbe1bcb6b0113fec0e88f06e5184decfe6d0398a90a41f7b1f4474113fc798eeb0a639d49e28b6e0a877be9ab4388dd2335c8b914375d56605a53885357a61f20d128d530696db36bfebe5c45475fb082a5813662ab5398c74156fd051b5746f1df66db494462ec63b008d7f91a351b25eff18de43c645cd2c2aee7835418f6d5bf4ece1bc3d268c934777128fcef5862a97c171bf487ce7be67bf7e974bfb35ebf1bbfc120173769e777a692d712936ffb34a65e985daaa216d8246a8fa72d1627648c6d479fd45222a55ce2d3dfadb43a9efc9cc2d491de41f40450a8d9d0aa6277ce4b2419c1149757cf304c5916dea3781c784e5abfbf51f0111490f2a0ac9ed2a1edd3ff3ed7d5854447aeb90d388bb057fcbc56a4b77479a0564e1da9845f5643227248f658ddebd896d73a32fbbb6f300000000000000000000000000000000000000000000000000000000000000147dd81c07986778f2a3131dab6d3d6d4d8265acba6b9703a11583cacb12fcf565c4899c46cd11c350b5c79ef5d857b1a058d7bcf722e39d00700fcc5f91bd7738ca1e8d0f2a1b9ede15a893050fe0b9c20f129eee97f0835ce7a9a4702c90da8ca4f3b29895bddf6fcd4478dcb33678e477322a9636ee68b219973f9d6579bfb4b6d1e12de0d5dd3807f4c23922dd55d0c10e38c7ba6a9520fe03760110b1e9c97aeef02fdb7fbb30e6cac674504ee8ea571ca397dd8d240b7a1aec7a2ee39c95f0a875c4ab6ae8bb77abdca15c37ee59b9b5051038a894b000fe1346d6426aa58a41cb2c6ff597db246be1fde1f0a0c8ffe8a8aacd471c5f69cbd5625a768d331cbdf59c2fcbaaeb5b89cd71c3f14a7c42fa1c8f6454d697289f451336367f1063813e18bb2aa5784cdb7441fe3205c3d826f8aa4e591bb53ecfffe776f724bee88814f9a3b79de4dda7c6b79087538541fdad25f9ffa3a9c7e6123194b14a57ba69effca5c8ab94ec083bc3a22f5221909764aa765607a72b00a2c36501eb154d6fa4294c6ba9e41e0318613f2bab841a7abb549dad298706b3fdd0e46fb208fc5263de51c81388bdba4a2780384e9448dc1f7fda194838fe018ee022df556245d0254e7781bf913f25b484d409014611e224befb13f615812ab6610dbe8b2f2812d0def026f1906657bbc9031acc13490580fc27e17c0a72f1c8ba6cbc1e0b30a0ff614d0a7ed9cdb6b8f51210a0f6cf59d81574159a5c9d1a215413fcccc9be2267ebe0eca51969f8e7d51517c3bd078f2bba3d0d56e0dbf28c4c1ca1685ec784e5abfbf51f0111490f2a0ac9ed2a1edd3ff3ed7d5854447aeb90d388bb057fcbc56a4b77479a0564e1da9845f5643227248f658ddebd896d73a32fbbb6f300000000000000000000000000000000000000000000000000000000000000143393bb536ce81533e5a8d37551b000421f47a69dc3f565fa8e2e96e37ca59c3befa09bd874dfe67ce93bda79932fef5c74cada051a73d9430c637d269f558458e4ebed8276649332ba0e2673d4cff16535d828b63268e00bce07bc41bd3e63e187ff3939d6dff724312fb85d068d8ff69a7c6570f88c4411ae6f1a2b28c719088e7d7ba57b281f25afc17482653132b9f5f88bf557ca2738fde4ac88a64869b0b9fe8a45136b2f73a8c961dc71e5c3f19e3e8beedd041b5c04b92e18b0459e2d2676fd0a652b98a2d0ffd3acde581e5180032ff9cbe6eacda6ee732748a8117cbc3c309e0689ac6a3ba61a7c53970d65263e65e3f60a3286b4087120803182f240fee65fdc2a77b406185bc992aefed421ffb9f021009d00ca3352620e12caa868bdfd6dff562c4db4440b3ba2dcf572471e3fc1757b823755f3a6ddc4f54b1efac050c9a6132b193d3933e0dc4cdc82f4ee9dee72e79ca92a87f6c62d76e3fecd02cda2eb9cd7029b0d5f8b346544e02c44d4f1813e1986f6e5f598ae9c17b254474d2a0fc9429c6327008c73e066f311d8e6405a36ad18ceb33af105c5d801217d6d15a48ab5e7f6590efa84f0a14ed9bf239b85fd9e990b911551682096b6181c6707c31d100bca21f9222ae3ab5295647d160c5b70c976975c7cdaab9fa74d8476053ef4a2dbf083be2919e8d9c8edd140b8a1a7908d6ac68abed30e4e7011f89fc88283c60afca9dbcb1e6742423c93f35069d02b442eb7cf15589296cd7f11af7aab1a90c2165aaac0ee06ab0b1c5de2b72ca2fdae2ccb08ea2a4c45f36db2f0dcc2a01265d632ab10b59b864768c3f203602d8e4946c62fa12d0bdacd7fcbc56a4b77479a0564e1da9845f5643227248f658ddebd896d73a32fbbb6f3";

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), PIN_BLOCK);

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "merkl.zac.yaml");
    }

    // ============================================================
    // claim(users, tokens, amounts, proofs) — every param `pass`
    // ============================================================

    /// The real thing: replay a live claim byte-for-byte through the modifier. Passing the
    /// gate AND settling proves the policy admits genuine claims; the cumulative `claimed`
    /// bookkeeping landing on the distributor proves it executed rather than merely cleared.
    ///
    /// One piece of setup is NOT part of the policy and is staged directly: the original
    /// claimer approves the Safe as their claiming operator (`toggleOperator`, pranked as the
    /// user). Without it the distributor refuses third-party claims — asserted first, because
    /// that refusal is half of the template's safety argument.
    function test_claim_replayLiveTransaction() public {
        uint256 pendleBefore = IERC20(PENDLE).balanceOf(USER);

        // Unapproved, the SAME calldata is refused by the DISTRIBUTOR (NotWhitelisted), not
        // by the policy: `shouldRevert=false` swallows the protocol revert to ok=false.
        vm.prank(ALICE);
        bool okUnapproved =
            IRoles(modAddr).execTransactionWithRole(DISTRIBUTOR, 0, CLAIM_CALLDATA, CALL, ROLE_KEY, false);
        assertFalse(okUnapproved, "distributor accepted a third-party claim without operator approval");

        // --- setup outside the policy: the user makes the Safe an approved operator ---
        vm.prank(USER);
        IMerklDistributor(DISTRIBUTOR).toggleOperator(USER, safeAddr);

        vm.prank(ALICE);
        bool ok = IRoles(modAddr).execTransactionWithRole(DISTRIBUTOR, 0, CLAIM_CALLDATA, CALL, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");

        (uint208 a,,) = IMerklDistributor(DISTRIBUTOR).claimed(USER, TOKEN_A);
        (uint208 p,,) = IMerklDistributor(DISTRIBUTOR).claimed(USER, PENDLE);
        (uint208 c,,) = IMerklDistributor(DISTRIBUTOR).claimed(USER, TOKEN_C);
        assertEq(a, CUM_A, "TOKEN_A cumulative claim not recorded");
        assertEq(p, CUM_PENDLE, "PENDLE cumulative claim not recorded");
        assertEq(c, CUM_C, "TOKEN_C cumulative claim not recorded");

        // The payout went to the third-party user, not to the Safe: the template's central
        // safety argument, asserted rather than narrated.
        assertGt(IERC20(PENDLE).balanceOf(USER), pendleBefore, "rewards did not reach their owner");
        assertEq(IERC20(PENDLE).balanceOf(safeAddr), 0, "rewards leaked to the Safe");
    }

    /// An empty claim clears the GATE — the policy has nothing to say about array contents
    /// (see the template header) — and is then refused by the DISTRIBUTOR (`InvalidLengths`
    /// rejects zero-length claims). `shouldRevert=false`: a policy rejection would still
    /// revert `ConditionViolation`, so returning at all proves the gate allowed it, and
    /// ok=false proves the refusal was the protocol's.
    function test_claim_emptyArrays_clearsGate() public {
        address[] memory users = new address[](0);
        address[] memory tokens = new address[](0);
        uint256[] memory amounts = new uint256[](0);
        bytes32[][] memory proofs = new bytes32[][](0);
        vm.prank(ALICE);
        bool ok = IRoles(modAddr)
            .execTransactionWithRole(
                DISTRIBUTOR,
                0,
                abi.encodeCall(IMerklDistributor.claim, (users, tokens, amounts, proofs)),
                CALL,
                ROLE_KEY,
                false
            );
        assertFalse(ok, "distributor accepted a zero-length claim");
    }

    // ============================================================
    // Non-allowed methods — the redirection vectors
    // ============================================================

    /// `claimWithRecipient` is the attack surface the template exists to exclude: with it, a
    /// member could route the SAFE's rewards to an arbitrary recipient.
    function test_nonAllowed_claimWithRecipient_rejected() public {
        address[] memory users = new address[](1);
        users[0] = safeAddr;
        address[] memory tokens = new address[](1);
        tokens[0] = PENDLE;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);
        address[] memory recipients = new address[](1);
        recipients[0] = BOGUS;
        bytes[] memory datas = new bytes[](1);
        datas[0] = "";
        expectPolicyReject(
            modAddr,
            ALICE,
            DISTRIBUTOR,
            abi.encodeCall(IMerklDistributor.claimWithRecipient, (users, tokens, amounts, proofs, recipients, datas)),
            CALL,
            ROLE_KEY
        );
    }

    /// `setClaimRecipient` would persistently reroute every future claim of the Safe.
    function test_nonAllowed_setClaimRecipient_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            DISTRIBUTOR,
            abi.encodeCall(IMerklDistributor.setClaimRecipient, (BOGUS, PENDLE)),
            CALL,
            ROLE_KEY
        );
    }

    /// `toggleOperator` would authorise an external operator to claim on the Safe's behalf,
    /// outside this policy's gate entirely.
    function test_nonAllowed_toggleOperator_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            DISTRIBUTOR,
            abi.encodeCall(IMerklDistributor.toggleOperator, (safeAddr, BOGUS)),
            CALL,
            ROLE_KEY
        );
    }

    /// Governance-gated on the distributor anyway, but asserted so the policy's default-deny
    /// is backed by a test rather than inferred.
    function test_nonAllowed_recoverERC20_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            DISTRIBUTOR,
            abi.encodeCall(IMerklDistributor.recoverERC20, (PENDLE, BOGUS, 1)),
            CALL,
            ROLE_KEY
        );
    }

    // ============================================================
    // Non-allowed target (correct selector, target NOT in policy)
    // ============================================================

    function test_nonAllowedTarget_claim_rejected() public {
        expectPolicyReject(modAddr, ALICE, BOGUS, CLAIM_CALLDATA, CALL, ROLE_KEY);
    }

    // ============================================================
    // ExecutionOptions (allowed target AND selector, wrong execution mode)
    // ============================================================

    /// `execution_options: "none"` — no delegatecall: the distributor running in the SAFE's
    /// storage context would be a total compromise.
    function test_executionOptions_delegatecall_rejected() public {
        expectPolicyReject(modAddr, ALICE, DISTRIBUTOR, CLAIM_CALLDATA, DELEGATECALL, ROLE_KEY);
    }

    /// `execution_options: "none"` — no ETH may ride along with a claim.
    function test_executionOptions_valueAttached_rejected() public {
        expectPolicyRejectWithValue(modAddr, ALICE, DISTRIBUTOR, 1 wei, CLAIM_CALLDATA, CALL, ROLE_KEY);
    }
}
