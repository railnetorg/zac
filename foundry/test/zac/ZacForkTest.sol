// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test, Vm} from "forge-std/Test.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface IModuleProxyFactory {
    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface IEnableModule {
    function enableModule(address module) external;
}

interface IRoles {
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool success);
}

/// @notice Abstract base for ZAC fork integration tests. Inheriting tests fork a chain in
///         `setUp`, apply a rendered Roles policy, then assert the Modifier's allow/deny.
/// @dev    The policy is rendered + planned by the ZAC CLI (`generate` then `plan`) over
///         FFI, and the resulting owner-gated role-state-update calls are executed inside
///         forge's EVM as the Safe (`vm.prank`), so any fork RPC works. Inheriting tests
///         call `deployRolesFixture` to stand up a fresh Safe + Roles V2 Modifier, then
///         `applyConfigFile` to apply a policy fixture (a `.zac.yaml` in the test folder).
abstract contract ZacForkTest is Test {
    /// @notice Safe v1.4.1 + Zodiac CREATE2 factories and mastercopies for one chain,
    ///         used to stand up a fresh Safe + Roles V2 Modifier.
    struct SafeConfig {
        address safeProxyFactory;
        address safeSingleton;
        address moduleProxyFactory;
        address rolesMastercopy;
    }

    /// @notice A freshly deployed Safe + Roles V2 Modifier pair on the fork.
    struct RolesFixture {
        address safe;
        address modifier_;
    }

    /// @notice Per-chain `SafeConfig`s. The Safe v1.4.1 + Zodiac deployments are
    ///         CREATE2-deterministic — identical addresses on every chain they're on — so a
    ///         chain that ever diverges overrides just its own entry.
    function mainnetSafeConfig() internal pure returns (SafeConfig memory) {
        return SafeConfig({
            safeProxyFactory: 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67,
            safeSingleton: 0x41675C099F32341bf84BFc5382aF534df5C7461a,
            moduleProxyFactory: 0x000000000000aDdB49795b0f9bA5BC298cDda236,
            rolesMastercopy: 0x9646fDAD06d3e24444381f44362a3B0eB343D337
        });
    }

    function baseSafeConfig() internal pure returns (SafeConfig memory) {
        return mainnetSafeConfig();
    }

    /// @notice Deploy a fresh Safe (owner = `member`, threshold 1) and a fresh Roles V2
    ///         Modifier (owner/avatar/target = the Safe) on the active fork, enable the
    ///         Modifier on the Safe, and enable `member` on the Modifier so it clears the
    ///         Modifier's `moduleOnly` gate. Returns the deployed addresses.
    /// @dev    Deploys run through `cfg`'s factories in forge's EVM; module wiring is
    ///         applied as the Safe via `vm.prank`.
    function deployRolesFixture(SafeConfig memory cfg, address member) internal returns (RolesFixture memory fx) {
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
        address safe =
            ISafeProxyFactory(cfg.safeProxyFactory).createProxyWithNonce(cfg.safeSingleton, safeInit, saltNonce);

        bytes memory modInit = abi.encodeWithSignature("setUp(bytes)", abi.encode(safe, safe, safe));
        address modifier_ =
            IModuleProxyFactory(cfg.moduleProxyFactory).deployModule(cfg.rolesMastercopy, modInit, saltNonce);

        // As the Safe — its own module-management authority and the Modifier's owner —
        // enable the Modifier on the Safe and `member` on the Modifier.
        vm.startPrank(safe);
        IEnableModule(safe).enableModule(modifier_);
        IEnableModule(modifier_).enableModule(member);
        vm.stopPrank();

        fx = RolesFixture({safe: safe, modifier_: modifier_});
    }

    /// @notice Apply a deployment-config fixture (a `.zac.yaml` under
    ///         `test/fork/templates/test_config/`) to the fresh fixture. The file is a full
    ///         deployment config with placeholders for the values only known at runtime,
    ///         substituted here:
    ///           `__MODIFIER__`  → the deployed Roles Modifier
    ///           `__SAFE__`      → the deployed Safe
    ///           `__MEMBER__`    → `member` (the role member the policy authorises)
    ///           `__TEMPLATES__` → the absolute `templates/` dir (for the `template:` path)
    /// @param  fixtureName file name of the fixture under
    ///         `test/fork/templates/test_config/`, e.g. "helper.zac.yaml".
    function applyConfigFile(RolesFixture memory fx, address member, string memory fixtureName) internal {
        string memory templatesDir = string.concat(vm.projectRoot(), "/../templates");

        string memory cfg =
            vm.readFile(string.concat(vm.projectRoot(), "/test/fork/templates/test_config/", fixtureName));
        cfg = vm.replace(cfg, "__MODIFIER__", vm.toString(fx.modifier_));
        cfg = vm.replace(cfg, "__SAFE__", vm.toString(fx.safe));
        cfg = vm.replace(cfg, "__MEMBER__", vm.toString(member));
        cfg = vm.replace(cfg, "__TEMPLATES__", templatesDir);

        // CLI layout: <network>/<safe-address>/<name>.zac.yaml.
        string memory configDir = string.concat(vm.projectRoot(), "/cache/zac-fork-test/mainnet/", vm.toString(fx.safe));
        string[] memory mkdir = new string[](3);
        mkdir[0] = "mkdir";
        mkdir[1] = "-p";
        mkdir[2] = configDir;
        vm.ffi(mkdir);
        string memory configPath = string.concat(configDir, "/test.zac.yaml");
        vm.writeFile(configPath, cfg);

        // The repo's root `examples/config.yaml` is passed via `--config` so alias namespaces
        // resolve from outside the `examples/` hierarchy.
        _applyInProcess(configPath, string.concat(vm.projectRoot(), "/../examples/config.yaml"));
    }

    /// @dev Roles v2 `PermissionChecker.ConditionViolation(Status,bytes32)` selector — the
    ///      error the Modifier raises when a call fails the per-parameter policy. Asserting it
    ///      (rather than a bare revert) confirms the rejection came from the policy gate.
    bytes4 internal constant ROLES_CONDITION_VIOLATION = 0xd0a9bf58;

    /// @notice Assert `member`'s `execTransactionWithRole(to, 0, data, operation, roleKey)` is
    ///         rejected at the Roles policy gate (reverts with `ConditionViolation`).
    function expectPolicyReject(
        address modifier_,
        address member,
        address to,
        bytes memory data,
        uint8 operation,
        bytes32 roleKey
    ) internal {
        vm.prank(member);
        // Partial match: assert the `ConditionViolation` selector, ignoring its
        // `Status`/`info` args (which differ per violated parameter).
        vm.expectPartialRevert(ROLES_CONDITION_VIOLATION);
        IRoles(modifier_).execTransactionWithRole(to, 0, data, operation, roleKey, false);
    }

    /// @dev Generate + `plan` via the ZAC CLI (FFI), then execute each planned
    ///      role-state-update call as the Safe (the Modifier's owner). `plan` emits the
    ///      role-update calls, which the test applies directly.
    function _applyInProcess(string memory configPath, string memory rootConfigPath) private {
        // Unique temp path per (test contract, call site).
        string memory id = string.concat(vm.toString(uint256(uint160(address(this)))), "-", vm.toString(gasleft()));
        // `plan` takes the `.zac.yaml` source and derives its sibling generated
        // `.yaml`, so generate must write the generated config alongside the source.
        string memory generatedPath = vm.replace(configPath, ".zac.yaml", ".yaml");
        string memory planPath = string.concat("/tmp/zac-plan-", id, ".json");

        _zac("generate", configPath, generatedPath, rootConfigPath);
        _zac("plan", configPath, planPath, rootConfigPath);

        // Per-field parsing reads only the fields used here; any others are ignored.
        string memory planJson = vm.readFile(planPath);
        address owner = vm.parseJsonAddress(planJson, ".safeAddress");
        uint256 callsCount = vm.parseJsonUint(planJson, ".callsCount");
        require(callsCount > 0, "ZacForkTest: plan produced no calls");

        for (uint256 i = 0; i < callsCount; i++) {
            string memory base = string.concat(".calls[", vm.toString(i), "]");
            address to = vm.parseJsonAddress(planJson, string.concat(base, ".to"));
            bytes memory data = vm.parseJsonBytes(planJson, string.concat(base, ".data"));
            // Every planned call targets the Modifier (value 0) and is owner-gated.
            vm.prank(owner);
            (bool ok,) = to.call(data);
            require(ok, "ZacForkTest: plan call reverted");
        }

        emit log_named_uint("zac plan applied calls", callsCount);
    }

    /// @dev Run a ZAC CLI subcommand over FFI; revert with stderr on a non-zero exit.
    function _zac(string memory sub, string memory inPath, string memory outPath, string memory rootConfigPath)
        private
    {
        bool hasRoot = bytes(rootConfigPath).length > 0;
        uint256 n = 6 + (hasRoot ? 2 : 0);
        string[] memory cmd = new string[](n);
        cmd[0] = "bun";
        cmd[1] = "../action/cli.ts";
        cmd[2] = sub;
        cmd[3] = inPath;
        cmd[4] = "--out";
        cmd[5] = outPath;
        if (hasRoot) {
            cmd[6] = "--config";
            cmd[7] = rootConfigPath;
        }
        Vm.FfiResult memory r = vm.tryFfi(cmd);
        if (r.exitCode != 0) {
            revert(string.concat("zac ", sub, " failed: ", string(r.stderr)));
        }
    }
}
