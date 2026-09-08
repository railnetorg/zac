// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script, console} from "forge-std/Script.sol";

// ─── External surfaces ────────────────────────────────────────────────────────

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface IModuleProxyFactory {
    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce) external returns (address);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function enableModule(address module) external;
    function isModuleEnabled(address module) external view returns (bool);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
}

interface ILagoonFactory {
    /// @dev The `bytes` overload. The struct overload on this factory still encodes the
    ///      legacy 12-field InitStruct, which a v0.6.0 vault cannot decode — see the
    ///      note on `_vaultInitCalldata`.
    function createVaultProxy(
        address logic,
        address initialOwner,
        uint256 initialDelay,
        bytes memory callData,
        bytes32 salt
    ) external returns (address);
    function isInstance(address proxy) external view returns (bool);
    function registry() external view returns (address);
    function wrappedNativeToken() external view returns (address);
}

interface ILagoonRegistry {
    function canUseLogic(address user, address logic) external view returns (bool);
    function defaultLogic() external view returns (address);
}

interface ILagoonVault {
    function version() external view returns (string memory);
    function syncMode() external view returns (uint8);
    function isAsyncOnly() external view returns (bool);
    function asset() external view returns (address);
    function safe() external view returns (address);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function activateAsyncOnly() external;
    function lockSuperOperator() external;
    function updateSuperOperator(address superOperator) external;
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}

/// @dev Lagoon v0.6.0 `InitStruct`, field for field. Encoded here rather than taken from the
///      factory's own struct overload, which still speaks the legacy 12-field shape.
struct InitStruct {
    address underlying;
    string name;
    string symbol;
    address safe;
    address whitelistManager;
    address valuationManager;
    address admin;
    address feeReceiver;
    uint16 managementRate;
    uint16 performanceRate;
    uint8 accessMode;
    uint16 entryRate;
    uint16 exitRate;
    uint16 haircutRate;
    address securityCouncil;
    address externalSanctionsList;
    uint256 initialTotalAssets;
    address superOperator;
    bool allowHighWaterMarkReset;
}

/// @title  DeployLagoonVault
/// @notice Deploys one specialized-vehicle substrate: a 1/1 Safe, a Zodiac Roles V2 modifier
///         on it, and a Lagoon v0.6.0 vault curated by that Safe, pinned to async-only.
///
/// @dev    Everything this script exists for is a value that is wrong by default.
///
///         **The Lagoon implementation.** `createVaultProxy` takes the logic as its first
///         argument, and the protocol registry's `defaultLogic()` is still v0.5.0. A vault
///         deployed through any path that does not name a logic is therefore a v0.5.0 vault,
///         which has no `setSyncMode` at all and so cannot be pinned async-only — the
///         configuration `hangar`'s `ERC7540Vehicle` requires (see its `VEHICLE.md`).
///
///         **The sync mode, permanently.** A fresh v0.6.0 vault initializes to
///         `SyncMode.Both`: both sync entrypoints open. `setSyncMode(None)` closes them but is
///         `onlySafe` and **reversible** — the Safe's owners can call it again at any time,
///         directly, without passing through the Roles modifier. So withholding `setSyncMode`
///         from role members in the policy does not make the property durable.
///         `activateAsyncOnly()` does: it is `onlyOwner`, irreversible, and strictly stronger.
///         `ERC7540Lib.setAsyncOnly` sets `isAsyncOnly`, zeroes `totalAssetsExpiration` and
///         `totalAssetsLifespan`, and sets `syncMode` to `None` itself — so it replaces the
///         mode-setting rather than complementing it. It runs here, before the vault has taken
///         a single deposit.
///
///         **The Roles mastercopy.** The June 2026 Zodiac advisory (Roles Modifier v2 and
///         Delay Modifier v1.1.0; exploited against Gnosis Pay on 2026-06-01) was an ERC-1271
///         check that read the returned magic value without checking that the call had
///         succeeded. Gnosis Guild redeployed the mastercopy. `ROLES_MASTERCOPY` below is the
///         post-patch address, and `_assertPatchedMastercopy` refuses to run against the
///         superseded one rather than leaving that as a comment nobody re-reads.
///
///         **Two steps are deliberately left outstanding**, because each needs an authority
///         this script does not hold: `enableModule` on the Safe needs its quorum, and
///         `acceptOwnership` on the vault needs the nominated admin. Both are printed at the
///         end with their calldata. Neither is load-bearing for what the run makes
///         irreversible, which is done and asserted by the time they are printed.
///
///         The Safe is created at the operator's own quorum (`SAFE_OWNERS`, `SAFE_THRESHOLD`),
///         or reused by passing `SAFE_ADDRESS`. `DEPLOYER` is the broadcasting key, and is the
///         vault's admin only for the duration of the run.
///
///         **What this script does NOT do.** Spawning the `ERC7540Vehicle` over the vault is
///         a separate step in `hangar`, and its whitelisting is interleaved with the spawn
///         (predict the vehicle address, whitelist it, spawn, whitelist both queues). This
///         script stops at a vault that is ready to be wrapped.
///
///         Run:
///           forge script script/DeployLagoonVault.s.sol:DeployLagoonVault \
///             --rpc-url "$MAINNET_RPC_URL" --broadcast --verify
contract DeployLagoonVault is Script {
    // ─── Fixed mainnet addresses ──────────────────────────────────────────────

    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant MODULE_PROXY_FACTORY = 0x000000000000aDdB49795b0f9bA5BC298cDda236;

    /// @dev Post-advisory Roles V2 mastercopy (gnosisguild/zodiac-modifier-roles#487).
    address constant ROLES_MASTERCOPY = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5;
    /// @dev Superseded by the June 2026 patch. Named so the check below can refuse it.
    address constant ROLES_MASTERCOPY_PRE_PATCH = 0x9646fDAD06d3e24444381f44362a3B0eB343D337;

    address constant LAGOON_FACTORY = 0x8D6f5479B14348186faE9BC7E636e947c260f9B1;
    /// @dev Lagoon logic v0.6.0. NOT the registry's `defaultLogic()`, which is still v0.5.0.
    address constant LAGOON_LOGIC_V0_6_0 = 0x6C77c47FB8168E22976C3B0338CB1769c952249f;

    /// @dev `SyncMode.None` — async only. The enum is Both=0, SyncDeposit=1, SyncRedeem=2.
    uint8 constant SYNC_MODE_NONE = 3;
    /// @dev `AccessMode.Whitelist`. A Lagoon-backed vehicle needs the whitelist: the vehicle
    ///      address and both queue addresses are whitelisted around the spawn.
    uint8 constant ACCESS_MODE_WHITELIST = 1;

    uint8 constant OP_CALL = 0;

    /// @dev The vault proxy's ProxyAdmin rejects a shorter upgrade timelock with
    ///      `DelayTooLow(86400)`. It is the floor, not a recommendation — pick the delay the
    ///      mandate wants and set `VAULT_UPGRADE_DELAY`; this is only what stops a run from
    ///      failing at the last call with an unexplained custom error.
    uint256 constant MIN_UPGRADE_DELAY = 1 days;

    // ─── Inputs ───────────────────────────────────────────────────────────────

    struct Params {
        address deployer; // The broadcasting key. Vault admin for the duration of the run.
        address[] safeOwners; // The Safe's owner set. Ignored when reusing a Safe.
        uint256 safeThreshold; // The Safe's quorum. Ignored when reusing a Safe.
        address existingSafe; // Reuse a Safe instead of deploying one; 0 to deploy.
        address underlying; // The vault's asset, e.g. WETH.
        string name;
        string symbol;
        address valuationManager; // The external NAV provider.
        address whitelistManager; // Must be ours: the spawn needs to whitelist mid-flight.
        address admin; // Who the vault's `onlyOwner` authority is nominated to, after the run.
        address feeReceiver;
        address securityCouncil;
        address proxyAdminOwner; // Upgrade authority over the vault proxy.
        uint256 upgradeDelay; // Timelock on that authority.
        uint16 managementRate;
        uint16 performanceRate;
        bytes32 salt;
        string deploymentKey; // Names the deployment artifact. Empty skips writing it.
    }

    /// @notice The three addresses the run produced. Recorded on the contract as well as
    ///         logged, so the fork test can assert against them without parsing output.
    address public deployedSafe;
    address public deployedModifier;
    address public deployedVault;

    function deployed() external view returns (address safe, address modifier_, address vault) {
        return (deployedSafe, deployedModifier, deployedVault);
    }

    function run() external {
        Params memory p = _readParams();
        _assertChainPrerequisites();

        vm.startBroadcast(p.deployer);

        address safe = p.existingSafe == address(0) ? _deploySafe(p, p.salt) : p.existingSafe;
        // The Safe carries the strategy's capital and settles the vault's epochs. The vault's
        // `onlyOwner` authority must not be the same entity: `updateSecurityCouncil` has no
        // lock, so an admin can always grant a role that proposes a NAV bypassing the
        // guardrails — and `settleDeposit` is `onlySafe` and reverts on a value mismatch. Two
        // separate authorities make that collusion-only instead of unilateral.
        require(p.admin != safe, "vault admin must not be the strategy Safe");

        address modifier_ = _deployRolesModifier(safe, p.salt);
        address vault = _deployVault(p, safe);
        _closeTheOneWayDoors(p, vault);
        _nominateAdmin(p, vault);

        vm.stopBroadcast();

        (deployedSafe, deployedModifier, deployedVault) = (safe, modifier_, vault);
        _writeArtifact(p, safe, modifier_, vault);

        console.log("safe      ", safe);
        console.log("modifier  ", modifier_);
        console.log("vault     ", vault);
        console.log("syncMode  ", ILagoonVault(vault).syncMode());
        console.log("asyncOnly ", ILagoonVault(vault).isAsyncOnly());
        console.log("vaultOwner", ILagoonVault(vault).owner());
        console.log("adminPending", ILagoonVault(vault).pendingOwner());

        // The two steps this script cannot take, in the order they have to happen.
        console.log("--- follow-ups, both through their own authority ---");
        console.log("1. enableModule on the Safe (needs its quorum). to:", safe);
        console.logBytes(abi.encodeCall(ISafe.enableModule, (modifier_)));
        console.log("2. acceptOwnership on the vault, as the nominated admin. to:", vault);
        console.logBytes(abi.encodeCall(ILagoonVault.acceptOwnership, ()));
    }

    // ─── Steps ────────────────────────────────────────────────────────────────

    /// @dev Everything the script depends on existing, checked before it spends anything.
    ///
    ///      The advisory is only useful as a check: a mastercopy with no code would silently
    ///      produce a module proxy that delegatecalls into nothing.
    ///
    ///      The Safe and Zodiac addresses are CREATE2-deterministic and identical on every
    ///      chain those deployments exist on, so they travel. **Lagoon's factory and logic do
    ///      not** — they are per-chain, and the ones above are Ethereum mainnet's. Running on
    ///      another chain without updating them would revert somewhere inside
    ///      `createVaultProxy` with nothing naming the cause, so they are checked here
    ///      instead.
    function _assertChainPrerequisites() internal view {
        require(ROLES_MASTERCOPY != ROLES_MASTERCOPY_PRE_PATCH, "Roles mastercopy is the pre-patch one");
        require(ROLES_MASTERCOPY.code.length > 0, "Roles mastercopy has no code on this chain");
        require(SAFE_PROXY_FACTORY.code.length > 0, "Safe proxy factory has no code on this chain");
        require(MODULE_PROXY_FACTORY.code.length > 0, "module proxy factory has no code on this chain");
        require(LAGOON_FACTORY.code.length > 0, "Lagoon factory has no code on this chain; update it for this network");
        require(
            LAGOON_LOGIC_V0_6_0.code.length > 0,
            "Lagoon v0.6.0 logic has no code on this chain; update it for this network"
        );
    }

    /// @dev Deployed at the operator's own quorum. The Roles modifier is NOT enabled here:
    ///      enabling it is a Safe transaction, and above a threshold of one this script cannot
    ///      produce the signatures. Safe's `setup` can enable a module through its `to`/`data`
    ///      delegatecall, but not this module — a Roles V2 modifier is initialised with the
    ///      Safe as owner/avatar/target, so its address depends on the Safe's and the Safe's
    ///      would depend on its. The circle has to be cut somewhere, and `enableModule` is the
    ///      cheapest place: it grants no authority by itself, and nothing else in this run
    ///      needs it.
    function _deploySafe(Params memory p, bytes32 salt) internal returns (address) {
        require(p.safeOwners.length > 0, "SAFE_OWNERS is empty");
        require(
            p.safeThreshold > 0 && p.safeThreshold <= p.safeOwners.length,
            "SAFE_THRESHOLD must be between 1 and the number of owners"
        );
        bytes memory init = abi.encodeCall(
            ISafe.setup,
            (p.safeOwners, p.safeThreshold, address(0), bytes(""), address(0), address(0), 0, payable(address(0)))
        );
        return ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, init, uint256(salt));
    }

    /// @dev `setUp(bytes)` takes (owner, avatar, target) — all three the Safe, so the Safe
    ///      owns the policy and the modifier acts on the Safe.
    function _deployRolesModifier(address safe, bytes32 salt) internal returns (address) {
        bytes memory init = abi.encodeWithSignature("setUp(bytes)", abi.encode(safe, safe, safe));
        return IModuleProxyFactory(MODULE_PROXY_FACTORY).deployModule(ROLES_MASTERCOPY, init, uint256(salt));
    }

    function _deployVault(Params memory p, address safe) internal returns (address) {
        require(
            ILagoonRegistry(ILagoonFactory(LAGOON_FACTORY).registry()).canUseLogic(p.deployer, LAGOON_LOGIC_V0_6_0),
            "the registry does not permit this deployer to use the v0.6.0 logic"
        );

        address vault = ILagoonFactory(LAGOON_FACTORY)
            .createVaultProxy(
                LAGOON_LOGIC_V0_6_0, p.proxyAdminOwner, p.upgradeDelay, _vaultInitCalldata(p, safe), p.salt
            );

        // The whole point of naming the logic explicitly. A vault that came out v0.5.0 has no
        // `setSyncMode`, so the next step would revert anyway — but it would revert without
        // saying why, and after the vault existed.
        require(
            keccak256(bytes(ILagoonVault(vault).version())) == keccak256(bytes("v0.6.0")),
            "vault did not deploy on the v0.6.0 logic"
        );
        require(ILagoonVault(vault).asset() == p.underlying, "vault asset is not the configured underlying");
        require(ILagoonVault(vault).safe() == safe, "vault is not curated by the deployed Safe");
        require(ILagoonFactory(LAGOON_FACTORY).isInstance(vault), "vault is not a factory instance");
        return vault;
    }

    /// @dev The factory's struct overload encodes the legacy 12-field `InitStruct` and hands
    ///      it to `initialize`, which on v0.6.0 decodes a 19-field struct — so that overload
    ///      cannot deploy a v0.6.0 vault. The `bytes` overload takes the initializer calldata
    ///      whole, which means building it here, `feeRegistry` and `wrappedNativeToken`
    ///      included; the struct overload would have injected those from factory storage.
    function _vaultInitCalldata(Params memory p, address safe) internal view returns (bytes memory) {
        InitStruct memory init = InitStruct({
            underlying: p.underlying,
            name: p.name,
            symbol: p.symbol,
            safe: safe,
            whitelistManager: p.whitelistManager,
            valuationManager: p.valuationManager,
            // The broadcaster, not `p.admin`. `activateAsyncOnly` and `lockSuperOperator` are
            // both `onlyOwner` and both have to run before the vault can take a deposit;
            // initialising with the final admin would leave them to a multisig transaction
            // nobody is forced to send. `p.admin` is nominated straight after.
            admin: p.deployer,
            feeReceiver: p.feeReceiver,
            managementRate: p.managementRate,
            performanceRate: p.performanceRate,
            accessMode: ACCESS_MODE_WHITELIST,
            entryRate: 0,
            exitRate: 0,
            haircutRate: 0,
            securityCouncil: p.securityCouncil,
            externalSanctionsList: address(0),
            initialTotalAssets: 0,
            superOperator: address(0),
            allowHighWaterMarkReset: false
        });
        return abi.encodeWithSignature(
            "initialize(bytes,address,address)",
            abi.encode(init),
            ILagoonFactory(LAGOON_FACTORY).registry(),
            ILagoonFactory(LAGOON_FACTORY).wrappedNativeToken()
        );
    }

    /// @dev The step the whole post-audit design rests on, and the reason it is
    ///      `activateAsyncOnly()` and not `setSyncMode(None)`: the latter is reversible by the
    ///      Safe's owners at any time, the former is permanent and sets the mode as part of its
    ///      own work.
    ///
    ///      `onlyOwner`, and the owner is `init.admin`. The vault is therefore initialized with
    ///      the broadcaster as admin and ownership handed over afterwards, rather than
    ///      initialized with the final admin and the activation left to them. Deferring it is
    ///      not hypothetical: the live CoinShares vault is `syncMode = None` with
    ///      `isAsyncOnly = false`.
    ///
    ///      Settlement is unaffected. The async path requires `totalAssets` to be INVALID —
    ///      `requestDeposit` carries `onlyAsyncDeposit`, which reverts when it is valid — and
    ///      zeroing the lifespan is what keeps it permanently so. It is the sync entrypoints
    ///      that need a valid `totalAssets`, which is what this call takes away for good.
    function _closeTheOneWayDoors(Params memory p, address vault) internal {
        require(ILagoonVault(vault).owner() == p.deployer, "vault admin is not the deployer; cannot activate");

        ILagoonVault(vault).activateAsyncOnly();
        require(ILagoonVault(vault).isAsyncOnly(), "async-only was not activated");
        require(ILagoonVault(vault).syncMode() == SYNC_MODE_NONE, "activation did not close the sync mode");

        ILagoonVault(vault).lockSuperOperator();
        // The lock is only worth anything if the setter is actually shut. Probed rather than
        // trusted, since `address(0)` would otherwise look identical before and after.
        (bool stillMutable,) = vault.call(abi.encodeCall(ILagoonVault.updateSuperOperator, (address(0))));
        require(!stillMutable, "superOperator is still mutable after lockSuperOperator");
    }

    /// @dev Hand the vault's `onlyOwner` authority to its intended holder, now that the
    ///      irreversible part is done and asserted.
    ///
    ///      The vault is `Ownable2Step`, so this only nominates: `p.admin` has to call
    ///      `acceptOwnership()`. That is the safer shape rather than a loose end — a mistyped
    ///      `VAULT_ADMIN` leaves the authority with the deployer instead of stranding the
    ///      vault, and the vault is already in its final irreversible configuration either
    ///      way. The run therefore ends with the deployer still owner and a nomination
    ///      outstanding.
    function _nominateAdmin(Params memory p, address vault) internal {
        if (p.admin == p.deployer) return;
        ILagoonVault(vault).transferOwnership(p.admin);
        require(ILagoonVault(vault).pendingOwner() == p.admin, "vault admin nomination failed");
    }

    // ─── Output ───────────────────────────────────────────────────────────────

    /// @dev Records the run as JSON under the Foundry root, at
    ///      `deployments/<network>/<DEPLOYMENT_KEY>.json`.
    ///
    ///      The path is relative to this Foundry project, not to whatever repository vendors
    ///      it as a submodule, so the same `fs_permissions` entry holds wherever the script
    ///      runs. Consumers copy the file out; nothing here assumes a layout above `foundry/`.
    ///
    ///      The salt is the load-bearing field. Every address in the file derives from it, so
    ///      a later run that reuses the salt reproduces them and a run that does not produces
    ///      a different vault — which is why the value has to be recorded rather than
    ///      remembered.
    ///
    ///      Only addresses are written. The asset is deliberately its address and not a token
    ///      symbol: the script never resolves symbols, and inventing one here would make the
    ///      file disagree with the chain the first time two tokens share a ticker.
    function _writeArtifact(Params memory p, address safe, address modifier_, address vault) internal {
        if (bytes(p.deploymentKey).length == 0) {
            console.log("DEPLOYMENT_KEY unset; no artifact written");
            return;
        }

        string memory dir = string.concat("deployments/", _networkName());
        vm.createDir(dir, true);

        string memory json = string.concat(
            "{\n",
            '  "chainId": ',
            vm.toString(block.chainid),
            ",\n",
            '  "salt": "',
            vm.toString(p.salt),
            '",\n',
            '  "safe": "',
            vm.toString(safe),
            '",\n',
            '  "modifier": "',
            vm.toString(modifier_),
            '",\n',
            '  "vault": "',
            vm.toString(vault),
            '",\n',
            '  "asset": "',
            vm.toString(p.underlying),
            '",\n',
            '  "admin": "',
            vm.toString(p.admin),
            '",\n',
            '  "valuationManager": "',
            vm.toString(p.valuationManager),
            '",\n',
            '  "whitelistManager": "',
            vm.toString(p.whitelistManager),
            '"\n',
            "}\n"
        );

        string memory path = string.concat(dir, "/", p.deploymentKey, ".json");
        vm.writeFile(path, json);
        console.log("artifact  ", path);
    }

    /// @dev The zac network directory name for this chain. Named rather than numeric because
    ///      that is what a zac repository's `config/<network>/` and `aliases/<network>/`
    ///      directories are keyed on, and an unknown chain has no such name to guess.
    function _networkName() internal view returns (string memory) {
        if (block.chainid == 1) return "mainnet";
        if (block.chainid == 8453) return "base";
        if (block.chainid == 11155111) return "sepolia";
        revert("no zac network name for this chain id; add it before writing an artifact");
    }

    // ─── Inputs ───────────────────────────────────────────────────────────────

    function _readParams() internal view returns (Params memory p) {
        p.deployer = vm.envAddress("DEPLOYER");
        p.existingSafe = vm.envOr("SAFE_ADDRESS", address(0));
        if (p.existingSafe == address(0)) {
            p.safeOwners = vm.envAddress("SAFE_OWNERS", ",");
            p.safeThreshold = vm.envUint("SAFE_THRESHOLD");
        }
        p.underlying = vm.envAddress("VAULT_UNDERLYING");
        p.name = vm.envString("VAULT_NAME");
        p.symbol = vm.envString("VAULT_SYMBOL");
        p.valuationManager = vm.envAddress("VAULT_VALUATION_MANAGER");
        p.whitelistManager = vm.envOr("VAULT_WHITELIST_MANAGER", p.deployer);
        p.admin = vm.envOr("VAULT_ADMIN", p.deployer);
        p.feeReceiver = vm.envOr("VAULT_FEE_RECEIVER", p.deployer);
        p.securityCouncil = vm.envOr("VAULT_SECURITY_COUNCIL", address(0));
        p.proxyAdminOwner = vm.envOr("VAULT_PROXY_ADMIN_OWNER", p.deployer);
        p.upgradeDelay = vm.envOr("VAULT_UPGRADE_DELAY", MIN_UPGRADE_DELAY);
        require(p.upgradeDelay >= MIN_UPGRADE_DELAY, "VAULT_UPGRADE_DELAY is below the ProxyAdmin floor");
        p.managementRate = uint16(vm.envOr("VAULT_MANAGEMENT_RATE", uint256(0)));
        p.performanceRate = uint16(vm.envOr("VAULT_PERFORMANCE_RATE", uint256(0)));
        p.salt = vm.envOr("DEPLOY_SALT", bytes32(0));
        p.deploymentKey = vm.envOr("DEPLOYMENT_KEY", string(""));
    }
}
