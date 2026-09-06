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
    function asset() external view returns (address);
    function safe() external view returns (address);
    function setSyncMode(uint8 mode) external;
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
///         **The sync mode.** A fresh v0.6.0 vault initializes to `SyncMode.Both`: both sync
///         entrypoints open. `setSyncMode(None)` is `onlySafe` and is not optional — it is
///         what makes the vault a valid substrate. It runs here, before the vault has taken
///         a single deposit.
///
///         **The Roles mastercopy.** The June 2026 Zodiac advisory (Roles Modifier v2 and
///         Delay Modifier v1.1.0; exploited against Gnosis Pay on 2026-06-01) was an ERC-1271
///         check that read the returned magic value without checking that the call had
///         succeeded. Gnosis Guild redeployed the mastercopy. `ROLES_MASTERCOPY` below is the
///         post-patch address, and `_assertPatchedMastercopy` refuses to run against the
///         superseded one rather than leaving that as a comment nobody re-reads.
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
        address owner; // Safe owner (1/1) and the broadcasting key.
        address existingSafe; // Reuse a Safe instead of deploying one; 0 to deploy.
        address underlying; // The vault's asset, e.g. WETH.
        string name;
        string symbol;
        address valuationManager; // The external NAV provider.
        address whitelistManager; // Must be ours: the spawn needs to whitelist mid-flight.
        address admin; // Vault owner (Lagoon-side admin).
        address feeReceiver;
        address securityCouncil;
        address proxyAdminOwner; // Upgrade authority over the vault proxy.
        uint256 upgradeDelay; // Timelock on that authority.
        uint16 managementRate;
        uint16 performanceRate;
        bytes32 salt;
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
        _assertPatchedMastercopy();

        vm.startBroadcast(p.owner);

        address safe = p.existingSafe == address(0) ? _deploySafe(p.owner, p.salt) : p.existingSafe;
        require(ISafe(safe).isOwner(p.owner), "owner is not an owner of the Safe");
        require(ISafe(safe).getThreshold() == 1, "Safe threshold is not 1");

        address modifier_ = _deployRolesModifier(safe, p.salt);
        _safeExec(safe, p.owner, safe, abi.encodeCall(ISafe.enableModule, (modifier_)));
        require(ISafe(safe).isModuleEnabled(modifier_), "modifier was not enabled on the Safe");

        address vault = _deployVault(p, safe);
        _pinAsyncOnly(safe, p.owner, vault);

        vm.stopBroadcast();

        (deployedSafe, deployedModifier, deployedVault) = (safe, modifier_, vault);

        console.log("safe      ", safe);
        console.log("modifier  ", modifier_);
        console.log("vault     ", vault);
        console.log("syncMode  ", ILagoonVault(vault).syncMode());
    }

    // ─── Steps ────────────────────────────────────────────────────────────────

    /// @dev The advisory is only useful as a check. A mastercopy with no code would silently
    ///      produce a module proxy that delegatecalls into nothing.
    function _assertPatchedMastercopy() internal view {
        require(ROLES_MASTERCOPY != ROLES_MASTERCOPY_PRE_PATCH, "Roles mastercopy is the pre-patch one");
        require(ROLES_MASTERCOPY.code.length > 0, "Roles mastercopy has no code on this chain");
    }

    function _deploySafe(address owner, bytes32 salt) internal returns (address) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init = abi.encodeCall(
            ISafe.setup, (owners, 1, address(0), bytes(""), address(0), address(0), 0, payable(address(0)))
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
            ILagoonRegistry(ILagoonFactory(LAGOON_FACTORY).registry()).canUseLogic(p.owner, LAGOON_LOGIC_V0_6_0),
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
            admin: p.admin,
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

    /// @dev The step the whole post-audit design rests on. A fresh v0.6.0 vault is
    ///      `SyncMode.Both` — both sync entrypoints open — and `ERC7540Vehicle` assumes
    ///      neither ever is. Runs before the vault can have taken a deposit.
    function _pinAsyncOnly(address safe, address owner, address vault) internal {
        _safeExec(safe, owner, vault, abi.encodeCall(ILagoonVault.setSyncMode, (SYNC_MODE_NONE)));
        require(ILagoonVault(vault).syncMode() == SYNC_MODE_NONE, "vault is not pinned to async-only");
    }

    // ─── Safe execution ───────────────────────────────────────────────────────

    /// @dev Execute `data` as the Safe on a 1/1 whose sole owner is the broadcaster, using
    ///      Safe's pre-validated signature form (`v=1`, `r=owner`, `s=0`), which Safe accepts
    ///      without an ECDSA signature when `msg.sender` is that owner. That keeps the script
    ///      free of any key handling beyond the one forge is already broadcasting with.
    function _safeExec(address safe, address owner, address to, bytes memory data) internal {
        bytes memory sig = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        bool ok = ISafe(safe).execTransaction(to, 0, data, OP_CALL, 0, 0, 0, address(0), payable(address(0)), sig);
        require(ok, "Safe transaction failed");
    }

    // ─── Inputs ───────────────────────────────────────────────────────────────

    function _readParams() internal view returns (Params memory p) {
        p.owner = vm.envAddress("SAFE_OWNER");
        p.existingSafe = vm.envOr("SAFE_ADDRESS", address(0));
        p.underlying = vm.envAddress("VAULT_UNDERLYING");
        p.name = vm.envString("VAULT_NAME");
        p.symbol = vm.envString("VAULT_SYMBOL");
        p.valuationManager = vm.envAddress("VAULT_VALUATION_MANAGER");
        p.whitelistManager = vm.envOr("VAULT_WHITELIST_MANAGER", p.owner);
        p.admin = vm.envOr("VAULT_ADMIN", p.owner);
        p.feeReceiver = vm.envOr("VAULT_FEE_RECEIVER", p.owner);
        p.securityCouncil = vm.envOr("VAULT_SECURITY_COUNCIL", address(0));
        p.proxyAdminOwner = vm.envOr("VAULT_PROXY_ADMIN_OWNER", p.owner);
        p.upgradeDelay = vm.envOr("VAULT_UPGRADE_DELAY", MIN_UPGRADE_DELAY);
        require(p.upgradeDelay >= MIN_UPGRADE_DELAY, "VAULT_UPGRADE_DELAY is below the ProxyAdmin floor");
        p.managementRate = uint16(vm.envOr("VAULT_MANAGEMENT_RATE", uint256(0)));
        p.performanceRate = uint16(vm.envOr("VAULT_PERFORMANCE_RATE", uint256(0)));
        p.salt = vm.envOr("DEPLOY_SALT", bytes32(0));
    }
}
