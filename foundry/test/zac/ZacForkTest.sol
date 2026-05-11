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
    /// @notice Generate the ZAC config, compute the plan, and execute each
    ///         planned call as the impersonated Safe on the active fork.
    /// @param configPath YAML deployment config path relative to /foundry/.
    function zacApply(string memory configPath) internal {
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
            "/tmp/zac-generated-",
            vm.toString(uint256(uint160(address(this)))),
            "-",
            vm.toString(gasleft()),
            ".yaml"
        );
        string memory planPath = string.concat(generatedPath, ".plan.json");

        // 1. zac generate -> flattened deployment YAML
        string[] memory genCmd = new string[](6);
        genCmd[0] = "bun";
        genCmd[1] = "../action/cli.ts";
        genCmd[2] = "generate";
        genCmd[3] = configPath;
        genCmd[4] = "--out";
        genCmd[5] = generatedPath;
        Vm.FfiResult memory r = vm.tryFfi(genCmd);
        if (r.exitCode != 0) {
            revert(string.concat("zac generate failed: ", string(r.stderr)));
        }

        // 2. zac plan -> JSON describing role-state-update calls
        string[] memory planCmd = new string[](6);
        planCmd[0] = "bun";
        planCmd[1] = "../action/cli.ts";
        planCmd[2] = "plan";
        planCmd[3] = generatedPath;
        planCmd[4] = "--out";
        planCmd[5] = planPath;
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

        // 4. Fund + impersonate the Safe.
        // 10 ETH = 0x8ac7230489e80000
        vm.rpc(
            "anvil_setBalance",
            string.concat("[\"", safeStr, "\",\"0x8ac7230489e80000\"]")
        );
        vm.rpc(
            "anvil_impersonateAccount",
            string.concat("[\"", safeStr, "\"]")
        );

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

        vm.rpc(
            "anvil_stopImpersonatingAccount",
            string.concat("[\"", safeStr, "\"]")
        );

        // 6. Re-pin forge to the post-apply tip: startBlock + N.
        //    Why: forge's in-process EVM caches state at the pinned block.
        //    The eth_sendTransaction calls above moved anvil's tip but did
        //    NOT move forge's pin — without this, tests still read pre-apply
        //    state. Assumes auto-mining (anvil default = 1 block per tx).
        vm.rollFork(startBlock + callsCount);

        emit log_named_uint("zac plan executed calls", callsCount);
        emit log_named_uint("rolled forge fork to", startBlock + callsCount);
    }
}
