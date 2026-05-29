// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test, Vm} from "forge-std/Test.sol";

/// @notice Abstract base for ZAC fork integration tests. Inheriting tests
///         fork a chain via `vm.createSelectFork` in `setUp`, then call
///         `zacApply(configPath)` to run the ZAC CLI and execute the
///         resulting role-state-update calls against the live fork.
///
/// @dev RPC_URL must be set and must point at an anvil RPC (not a raw
///      upstream RPC) because the helper uses anvil_* cheats.
abstract contract ZacForkTest is Test {
    // --- Mainnet deterministic factories + mastercopies (CREATE2, same on every
    //     chain the respective project has deployed to) ---
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON_V1_4_1 = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address internal constant ZODIAC_MODULE_PROXY_FACTORY = 0x000000000000aDdB49795b0f9bA5BC298cDda236;
    address internal constant ROLES_V2_MASTERCOPY = 0x9646fDAD06d3e24444381f44362a3B0eB343D337;

    /// @notice A freshly deployed Safe + Roles V2 Modifier pair on the fork.
    struct RolesFixture {
        address safe;
        address modifier_;
    }

    /// @notice Deploy a fresh Safe (owner = `member`, threshold 1) and a fresh Roles V2
    ///         Modifier (owner/avatar/target = the Safe) on the active fork, enable the
    ///         Modifier on the Safe, and enable `member` on the Modifier so it clears the
    ///         Modifier's `moduleOnly` gate. Returns the deployed addresses.
    /// @dev    Addresses are predicted via read-only `eth_call` rather than an in-process
    ///         deployment: deploying in forge's EVM would give the Safe code locally, and
    ///         forge rejects `eth_sendTransaction` from a code-bearing sender (EIP-3607)
    ///         before forwarding to anvil. Deploys are batched per dependency phase so
    ///         cross-sender ordering within each mined block is deterministic.
    function deployRolesFixture(address member) internal returns (RolesFixture memory fx) {
        uint256 startBlock = block.number;
        uint256 saltNonce = vm.randomUint();

        address[] memory owners = new address[](1);
        owners[0] = member;
        bytes memory safeInit = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            uint256(1),
            address(0),
            bytes(""),
            address(0),
            address(0),
            uint256(0),
            address(0)
        );
        bytes memory createCd =
            abi.encodeWithSignature("createProxyWithNonce(address,bytes,uint256)", SAFE_SINGLETON_V1_4_1, safeInit, saltNonce);
        address safe = abi.decode(_anvilCall(SAFE_PROXY_FACTORY, createCd), (address));

        bytes memory modInit = abi.encodeWithSignature("setUp(bytes)", abi.encode(safe, safe, safe));
        bytes memory deployCd =
            abi.encodeWithSignature("deployModule(address,bytes,uint256)", ROLES_V2_MASTERCOPY, modInit, saltNonce);
        address modifier_ = abi.decode(_anvilCall(ZODIAC_MODULE_PROXY_FACTORY, deployCd), (address));

        vm.rpc("evm_setAutomine", "[false]");

        // Phase 1 — deploy the proxies (sender = member, an EOA: EIP-3607-safe).
        _anvilFundAndImpersonate(member);
        _anvilSendTx(member, SAFE_PROXY_FACTORY, createCd);
        _anvilSendTx(member, ZODIAC_MODULE_PROXY_FACTORY, deployCd);
        vm.rpc("anvil_mine", "[]");
        _anvilStopImpersonating(member);

        // Phase 2 — as the Safe (owner of both): enable the Modifier on the Safe and
        // `member` on the Modifier. Requires Phase 1's contracts to already exist.
        _anvilFundAndImpersonate(safe);
        _anvilSendTx(safe, safe, abi.encodeWithSignature("enableModule(address)", modifier_));
        _anvilSendTx(safe, modifier_, abi.encodeWithSignature("enableModule(address)", member));
        vm.rpc("anvil_mine", "[]");
        _anvilStopImpersonating(safe);

        vm.rpc("evm_setAutomine", "[true]");
        vm.rollFork(startBlock + 2);

        fx = RolesFixture({safe: safe, modifier_: modifier_});
    }

    /// @notice Wrap `configsYaml` (a `configs:` block) in a deployment-config envelope
    ///         pinned to `fx`, write it under `cache/`, and apply it. The repo's root
    ///         `examples/config.yaml` is passed via `--config` so alias namespaces still
    ///         resolve from outside the `examples/` hierarchy.
    function applyInlineConfig(RolesFixture memory fx, string memory configsYaml) internal {
        // Layout the CLI expects: <network>/<safe-address>/<name>.zac.yaml.
        string memory configDir =
            string.concat(vm.projectRoot(), "/cache/zac-fork-test/mainnet/", vm.toString(fx.safe));
        string[] memory mkdir = new string[](3);
        mkdir[0] = "mkdir";
        mkdir[1] = "-p";
        mkdir[2] = configDir;
        vm.ffi(mkdir);

        string memory cfg = string.concat(
            "roles_modifier_address: \"",
            vm.toString(fx.modifier_),
            "\"\n",
            "safe_address: \"",
            vm.toString(fx.safe),
            "\"\n",
            "chain_id: ",
            vm.toString(block.chainid),
            "\n",
            "name: ZAC fork test\n",
            "description: Materialised by a ZacForkTest at setUp time.\n",
            configsYaml
        );
        string memory configPath = string.concat(configDir, "/test.zac.yaml");
        vm.writeFile(configPath, cfg);

        zacApply(configPath, string.concat(vm.projectRoot(), "/../examples/config.yaml"));
    }

    /// @notice Absolute path to a template, for use inside a `configs:` block.
    function templatePath(string memory relPath) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/../templates/", relPath);
    }

    // --- anvil RPC plumbing ---

    function _anvilFundAndImpersonate(address addr) internal {
        // 10 ETH = 0x8ac7230489e80000.
        vm.rpc("anvil_setBalance", string.concat("[\"", vm.toString(addr), "\",\"0x8ac7230489e80000\"]"));
        vm.rpc("anvil_impersonateAccount", string.concat("[\"", vm.toString(addr), "\"]"));
    }

    function _anvilStopImpersonating(address addr) internal {
        vm.rpc("anvil_stopImpersonatingAccount", string.concat("[\"", vm.toString(addr), "\"]"));
    }

    /// @dev Read-only eth_call against anvil. Returns the ABI-encoded result.
    function _anvilCall(address to, bytes memory data) internal returns (bytes memory) {
        return vm.rpc(
            "eth_call",
            string.concat("[{\"to\":\"", vm.toString(to), "\",\"data\":\"", vm.toString(data), "\"},\"latest\"]")
        );
    }

    function _anvilSendTx(address from, address to, bytes memory data) internal {
        vm.rpc(
            "eth_sendTransaction",
            string.concat(
                "[{\"from\":\"",
                vm.toString(from),
                "\",\"to\":\"",
                vm.toString(to),
                "\",\"data\":\"",
                vm.toString(data),
                "\",\"value\":\"0x0\",\"gas\":\"0x4c4b40\"}]"
            )
        );
    }

    /// @notice Generate the ZAC config, compute the plan, and execute each
    ///         planned call as the impersonated Safe on the active fork.
    /// @param configPath YAML deployment config path relative to /foundry/.
    function zacApply(string memory configPath) internal {
        _zacApply(configPath, "");
    }

    /// @notice Render + plan + apply with an explicit `--config` root path. Use
    ///         when the `.zac.yaml` lives outside any `examples/` hierarchy and
    ///         `findConfig`'s upward walk can't otherwise reach the root
    ///         `config.yaml` that registers the alias namespaces.
    function zacApply(string memory configPath, string memory rootConfigPath) internal {
        _zacApply(configPath, rootConfigPath);
    }

    function _zacApply(string memory configPath, string memory rootConfigPath) private {
        // Hard-fail if RPC_URL unset; we'd have nothing to talk to.
        vm.envString("RPC_URL");

        // Capture forge's pinned block BEFORE the eth_sendTransaction calls
        // advance anvil's tip. FFI alone is read-only and does NOT move
        // anvil's tip — only the vm.rpc calls below do. With auto-mining
        // (anvil default = 1 block per tx), the post-apply tip is
        // startBlock + N, computed locally — no eth_blockNumber RPC.
        uint256 startBlock = block.number;

        // Unique temp paths per (test contract, call site).
        string memory generatedPath = string.concat(
            "/tmp/zac-generated-", vm.toString(uint256(uint160(address(this)))), "-", vm.toString(gasleft()), ".yaml"
        );
        string memory planPath = string.concat(generatedPath, ".plan.json");

        bool hasRootConfig = bytes(rootConfigPath).length > 0;

        // 1. zac generate -> flattened deployment YAML
        string[] memory genCmd = new string[](hasRootConfig ? 8 : 6);
        genCmd[0] = "bun";
        genCmd[1] = "../action/cli.ts";
        genCmd[2] = "generate";
        genCmd[3] = configPath;
        genCmd[4] = "--out";
        genCmd[5] = generatedPath;
        if (hasRootConfig) {
            genCmd[6] = "--config";
            genCmd[7] = rootConfigPath;
        }
        Vm.FfiResult memory r = vm.tryFfi(genCmd);
        if (r.exitCode != 0) {
            revert(string.concat("zac generate failed: ", string(r.stderr)));
        }

        // 2. zac plan -> JSON describing role-state-update calls
        string[] memory planCmd = new string[](hasRootConfig ? 8 : 6);
        planCmd[0] = "bun";
        planCmd[1] = "../action/cli.ts";
        planCmd[2] = "plan";
        planCmd[3] = generatedPath;
        planCmd[4] = "--out";
        planCmd[5] = planPath;
        if (hasRootConfig) {
            planCmd[6] = "--config";
            planCmd[7] = rootConfigPath;
        }
        r = vm.tryFfi(planCmd);
        if (r.exitCode != 0) {
            revert(string.concat("zac plan failed: ", string(r.stderr)));
        }

        // 3. Read plan JSON. Per-field parsing (vm.parseJson*) is robust
        //    against shape evolution — extra fields like safeTxData /
        //    safeTxHash (consumed only by `zac submit`) are simply ignored.
        string memory planJson = vm.readFile(planPath);
        address safeAddress = vm.parseJsonAddress(planJson, ".safeAddress");
        string memory safeStr = vm.toString(safeAddress);

        // 4. Fund + impersonate the Safe. Disable anvil auto-mining first so
        //    every queued tx lands in a single block we mine explicitly at
        //    the end — anvil's default auto-mining is asynchronous and the
        //    last submitted tx can linger in the mempool past our probe.
        // 10 ETH = 0x8ac7230489e80000
        vm.rpc("evm_setAutomine", "[false]");
        vm.rpc("anvil_setBalance", string.concat("[\"", safeStr, "\",\"0x8ac7230489e80000\"]"));
        vm.rpc("anvil_impersonateAccount", string.concat("[\"", safeStr, "\"]"));

        // 5. Iterate calls. We read `callsCount` from the plan JSON (set by
        //    serializePlan to calls.length) rather than vm.parseJsonKeys —
        //    parseJsonKeys is for *object keys*, not array indices.
        uint256 callsCount = vm.parseJsonUint(planJson, ".callsCount");
        for (uint256 i = 0; i < callsCount; i++) {
            string memory base = string.concat(".calls[", vm.toString(i), "]");
            address to = vm.parseJsonAddress(planJson, string.concat(base, ".to"));
            bytes memory data = vm.parseJsonBytes(planJson, string.concat(base, ".data"));
            // Modifier scoping calls are value=0 by construction; we emit 0x0
            // verbatim and skip parsing/converting the plan's decimal value.
            string memory txParams = string.concat(
                "[{\"from\":\"",
                safeStr,
                "\",\"to\":\"",
                vm.toString(to),
                "\",\"data\":\"",
                vm.toString(data),
                "\",\"value\":\"0x0\",\"gas\":\"0x4c4b40\"}]"
            );
            vm.rpc("eth_sendTransaction", txParams);
        }

        // 6. Mine all queued txs into a single new block, then restore
        //    anvil's auto-mining. anvil_mine with no args mines 1 block
        //    including every pending tx (sequential nonce order).
        vm.rpc("anvil_mine", "[]");
        vm.rpc("evm_setAutomine", "[true]");
        vm.rpc("anvil_stopImpersonatingAccount", string.concat("[\"", safeStr, "\"]"));

        // 7. Re-pin forge to the post-apply tip: startBlock + 1 (every
        //    queued tx batched into a single new block by anvil_mine).
        //    Why: forge's in-process EVM caches state at the pinned block.
        //    The eth_sendTransaction calls above moved anvil's tip but did
        //    NOT move forge's pin — without this, tests still read pre-apply
        //    state.
        vm.rollFork(startBlock + 1);

        emit log_named_uint("zac plan executed calls", callsCount);
        emit log_named_uint("rolled forge fork to", startBlock + 1);
    }
}
