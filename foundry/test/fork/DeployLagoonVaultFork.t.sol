// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {
    DeployLagoonVault,
    ILagoonVault,
    ISafe,
    ILagoonFactory,
    ILagoonRegistry,
    Rates
} from "script/DeployLagoonVault.s.sol";

/// @title  DeployLagoonVaultForkTest
/// @notice Runs `DeployLagoonVault` end to end against mainnet.
/// @dev    A deployment script is only ever run once per vault, by hand, against real money.
///         The failure mode is not a bug that shows up later — it is a vault that exists and
///         is wrong. So the script's entry point is exercised here rather than its parts:
///         same `run()`, same env vars, same factories.
///
///         What it pins is the set of defaults that are wrong. A vault deployed without
///         naming the logic comes out v0.5.0; a v0.6.0 vault initializes to `SyncMode.Both`
///         with both sync entrypoints open; closing that mode without making it permanent
///         leaves it one `onlySafe` call from being reopened; the legacy struct overload on the
///         factory cannot encode a v0.6.0 initializer at all. Each is a live default, and each
///         would produce a vault the `ERC7540Vehicle` cannot legitimately wrap.
///
///         `MAINNET_RPC_URL` must be set.
contract DeployLagoonVaultForkTest is Test {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DEPLOYER = 0x1111111111111111111111111111111111111111;
    address constant OWNER_B = 0x4444444444444444444444444444444444444444;
    address constant OWNER_C = 0x5555555555555555555555555555555555555555;
    address constant VALUATION_MANAGER = 0x2222222222222222222222222222222222222222;

    address constant LAGOON_FACTORY = 0x8D6f5479B14348186faE9BC7E636e947c260f9B1;
    address constant LAGOON_LOGIC_V0_6_0 = 0x6C77c47FB8168E22976C3B0338CB1769c952249f;
    address constant LAGOON_LOGIC_V0_5_0 = 0xE50554ec802375C9c3F9c087a8a7bb8C26d3DEDf;
    address constant ROLES_MASTERCOPY_PATCHED = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5;
    address constant ROLES_MASTERCOPY_PRE_PATCH = 0x9646fDAD06d3e24444381f44362a3B0eB343D337;

    uint8 constant SYNC_MODE_NONE = 3;
    address constant FINAL_ADMIN = 0x3333333333333333333333333333333333333333;
    string constant ARTIFACT_KEY = "fork_test";

    /// @dev The errors the probes below distinguish. `SuperOperatorUpdateLocked()` is the lock
    ///      itself; the two `Only…Manager(address)` errors carry the configured address, which
    ///      is the only way to read those roles back — the vault has no getter for either.
    bytes4 constant SUPER_OPERATOR_UPDATE_LOCKED = 0x691f9390;
    bytes4 constant ONLY_WHITELIST_MANAGER = 0x583a4fd6;
    bytes4 constant ONLY_VALUATION_MANAGER = 0x14c9222d;

    DeployLagoonVault script_;

    address deployedSafe;
    address deployedModifier;
    address deployedVault;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));
        script_ = new DeployLagoonVault();

        vm.setEnv("DEPLOYER", vm.toString(DEPLOYER));
        // A real quorum, not 1/1 — the shape they actually deploy.
        vm.setEnv(
            "SAFE_OWNERS", string.concat(vm.toString(DEPLOYER), ",", vm.toString(OWNER_B), ",", vm.toString(OWNER_C))
        );
        vm.setEnv("SAFE_THRESHOLD", "2");
        vm.setEnv("VAULT_UNDERLYING", vm.toString(WETH));
        vm.setEnv("VAULT_NAME", "Railnet Test WETH");
        vm.setEnv("VAULT_SYMBOL", "rnTWETH");
        vm.setEnv("VAULT_VALUATION_MANAGER", vm.toString(VALUATION_MANAGER));
        vm.setEnv("DEPLOY_SALT", vm.toString(bytes32(uint256(0xDEF1))));
        // Deliberately NOT the broadcaster, so the handover path is the one under test.
        vm.setEnv("VAULT_ADMIN", vm.toString(FINAL_ADMIN));
        vm.setEnv("DEPLOYMENT_KEY", ARTIFACT_KEY);

        // The deployment is the fixture. Foundry calls `setUp` once and restores the
        // post-setUp snapshot for each test, so this is one run rather than one per test —
        // which matters against a live RPC: each `run()` deploys a Safe, a modifier and a
        // Lagoon vault, and the fork suite has already hit provider rate limits on request
        // volume alone (a 429 surfaces in one test as a database error and in its siblings
        // as a bare `EvmError: Revert` at the first state access).
        script_.run();
        (deployedSafe, deployedModifier, deployedVault) = script_.deployed();
    }

    /// DF-1 — the whole run. Every invariant the script asserts internally is re-asserted
    ///        here against the deployed addresses, so a `require` quietly removed from the
    ///        script fails this test rather than shipping.
    function test_DF1_DeploysAnAsyncOnlyV060VaultCuratedByTheSafe() public {
        (address safe, address modifier_, address vault) = (deployedSafe, deployedModifier, deployedVault);
        assertTrue(safe != address(0) && modifier_ != address(0) && vault != address(0), "nothing deployed");

        assertEq(ILagoonVault(vault).version(), "v0.6.0", "vault is not on the v0.6.0 logic");
        assertEq(ILagoonVault(vault).syncMode(), SYNC_MODE_NONE, "sync mode is not None");
        assertTrue(ILagoonVault(vault).isAsyncOnly(), "async-only was not made permanent");
        // `Ownable2Step`: the run nominates, the admin accepts. Ending with the deployer
        // still owner is the intended state, not an incomplete one — the irreversible part is
        // already done, and a mistyped admin cannot strand the vault.
        assertEq(ILagoonVault(vault).owner(), DEPLOYER, "deployer should still be admin until accepted");
        assertEq(ILagoonVault(vault).pendingOwner(), FINAL_ADMIN, "intended admin was not nominated");

        vm.prank(FINAL_ADMIN);
        ILagoonVault(vault).acceptOwnership();
        assertEq(ILagoonVault(vault).owner(), FINAL_ADMIN, "admin could not accept the nomination");
        assertEq(ILagoonVault(vault).asset(), WETH, "vault underlying is wrong");
        assertEq(ILagoonVault(vault).safe(), safe, "vault is not curated by the deployed Safe");
        assertTrue(ILagoonFactory(LAGOON_FACTORY).isInstance(vault), "vault is not a factory instance");

        assertTrue(ISafe(safe).isOwner(DEPLOYER), "deployer is not an owner");
        assertTrue(ISafe(safe).isOwner(OWNER_B) && ISafe(safe).isOwner(OWNER_C), "co-owners missing");
        assertEq(ISafe(safe).getThreshold(), 2, "Safe was not deployed at the configured quorum");
        // The modifier is deployed but NOT enabled: that is a Safe transaction and the script
        // cannot produce a 2-of-3 signature. It is one of the two printed follow-ups.
        assertFalse(ISafe(safe).isModuleEnabled(modifier_), "script should not have enabled the module");
    }

    /// DF-2 — the modifier runs the post-advisory mastercopy. The June 2026 Zodiac advisory
    ///        (Roles Modifier v2; an ERC-1271 check that read the returned magic value without
    ///        checking the call succeeded) was fixed by a redeploy, so the only thing
    ///        separating a patched modifier from a vulnerable one is which address the module
    ///        proxy points at. Read out of the proxy's own runtime rather than trusted.
    function test_DF2_ModifierPointsAtThePatchedMastercopy() public {
        address modifier_ = deployedModifier;

        assertTrue(_delegatesTo(modifier_, ROLES_MASTERCOPY_PATCHED), "modifier is not on the patched mastercopy");
        assertFalse(_delegatesTo(modifier_, ROLES_MASTERCOPY_PRE_PATCH), "modifier is on the pre-patch mastercopy");
    }

    /// DF-4 — the activation is irreversible, which is the only reason it is worth doing. Once
    ///        `isAsyncOnly` is set, `setSyncMode` cannot reopen the sync path — so the property
    ///        survives the Safe's own owners, not just the Roles policy. Driven as the Safe,
    ///        which is the authority `setSyncMode` answers to.
    function test_DF4_SyncModeCannotBeReopenedAfterActivation() public {
        (address safe, address vault) = (deployedSafe, deployedVault);

        vm.prank(safe);
        (bool ok,) = vault.call(abi.encodeWithSignature("setSyncMode(uint8)", uint8(0)));

        assertFalse(ok, "the Safe was able to call setSyncMode on an async-only vault");
        assertEq(ILagoonVault(vault).syncMode(), SYNC_MODE_NONE, "sync mode was reopened");
        assertTrue(ILagoonVault(vault).isAsyncOnly(), "async-only flag was cleared");
    }

    /// DF-5 — `superOperator` is not merely zero, it is locked at zero. Zero disables the
    ///        role (`isSuperOperator` compares it against `msg.sender`, never zero), but
    ///        `updateSuperOperator` is open to the admin, so without the lock the zero is a
    ///        current value rather than a property. Probed as the admin, the authority that
    ///        setter answers to.
    ///
    ///        The revert reason is compared, not just the failure: an unauthorised caller
    ///        reverts too, so "it reverted" alone passes on a vault whose setter was never
    ///        locked at all. Same reasoning as the script's own probe.
    function test_DF5_SuperOperatorIsLockedAtZero() public {
        address vault = deployedVault;

        vm.prank(DEPLOYER);
        (bool ok, bytes memory reason) = vault.call(abi.encodeWithSignature("updateSuperOperator(address)", DEPLOYER));
        assertFalse(ok, "the admin was able to grant superOperator after the lock");
        assertEq(_selector(reason), SUPER_OPERATOR_UPDATE_LOCKED, "reverted for a reason other than the lock");
    }

    /// DF-8 — locked at ZERO, and `accessMode` is `Whitelist`. Two properties from one read,
    ///        because `lockSuperOperator` freezes whatever is in the slot and the vault has no
    ///        getter for it: a super operator is always `isAllowed`, so an address that is not
    ///        allowed is not the super operator. Nothing is whitelisted at this point, so
    ///        every address the run touched has to come back `false` — and if `accessMode` had
    ///        landed as open they would all come back `true`.
    ///
    ///        Without this, a non-zero `superOperator` in the hand-built initializer passes
    ///        the whole suite, DF-5 included, and locks a live role permanently.
    function test_DF8_NoAddressIsAllowedYet() public view {
        ILagoonVault vault = ILagoonVault(deployedVault);

        assertFalse(vault.isAllowed(DEPLOYER), "deployer is allowed; superOperator may be non-zero");
        assertFalse(vault.isAllowed(FINAL_ADMIN), "the nominated admin is allowed");
        assertFalse(vault.isAllowed(VALUATION_MANAGER), "the valuation manager is allowed");
        assertFalse(vault.isAllowed(OWNER_B), "a Safe owner is allowed");
        assertFalse(vault.isAllowed(deployedSafe), "the Safe itself is allowed");
    }

    /// DF-9 — the two manager roles landed where they were configured. Both are plain
    ///        addresses in a 19-field struct transcribed by hand, so swapping them deploys
    ///        cleanly and reports success: the NAV provider would hold the whitelist
    ///        authority, and the spawn's mid-flight `addToWhitelist` would revert on a vault
    ///        that is already live. Read out of the reverts that name them.
    function test_DF9_ManagerRolesLandedAsConfigured() public {
        address vault = deployedVault;

        (bool ok, bytes memory reason) =
            vault.call(abi.encodeWithSignature("addToWhitelist(address[])", new address[](0)));
        assertFalse(ok, "this test should not be the whitelistManager");
        assertEq(_selector(reason), ONLY_WHITELIST_MANAGER, "not the OnlyWhitelistManager error");
        // Unset in `setUp`, so it defaults to the deployer.
        assertEq(_addressArg(reason), DEPLOYER, "whitelistManager is not the configured address");

        (ok, reason) = vault.call(abi.encodeWithSignature("updateNewTotalAssets(uint256)", uint256(1)));
        assertFalse(ok, "this test should not be the valuationManager");
        assertEq(_selector(reason), ONLY_VALUATION_MANAGER, "not the OnlyValuationManager error");
        assertEq(_addressArg(reason), VALUATION_MANAGER, "valuationManager is not the configured address");
    }

    /// DF-10 — the fee rates survive the trip through the initializer. They are `uint16`
    ///         fields read from `uint256` environment variables, and the entry, exit and
    ///         haircut rates are pinned to zero by the script rather than configurable.
    function test_DF10_FeeRatesAreZeroAsConfigured() public view {
        Rates memory rates = ILagoonVault(deployedVault).feeRates();

        assertEq(rates.managementRate, 0, "managementRate");
        assertEq(rates.performanceRate, 0, "performanceRate");
        assertEq(rates.entryRate, 0, "entryRate");
        assertEq(rates.exitRate, 0, "exitRate");
        assertEq(rates.haircutRate, 0, "haircutRate");
    }

    /// DF-6 — the chain prerequisites are checked, and the Lagoon pair is the reason. The Safe
    ///        and Zodiac addresses are CREATE2-deterministic and travel between chains; the
    ///        Lagoon factory and logic are per-chain and compiled in for mainnet. Without this
    ///        the wrong chain reverts somewhere inside `createVaultProxy` with nothing naming
    ///        the cause. Simulated by removing the factory's code.
    function test_DF6_WrongChainFailsByName() public {
        vm.etch(LAGOON_FACTORY, "");
        vm.expectRevert(bytes("Lagoon factory has no code on this chain; update it for this network"));
        script_.run();
    }

    /// DF-3 — the default is the wrong one. If the registry ever makes v0.6.0 the default this
    ///        test starts failing, which is the moment to simplify the script; until then it
    ///        records why the logic is named explicitly.
    function test_DF3_RegistryDefaultIsStillV050() public view {
        address registry = ILagoonFactory(LAGOON_FACTORY).registry();
        assertEq(ILagoonRegistry(registry).defaultLogic(), LAGOON_LOGIC_V0_5_0, "registry default changed");
        assertTrue(
            ILagoonRegistry(registry).canUseLogic(DEPLOYER, LAGOON_LOGIC_V0_6_0), "v0.6.0 is no longer freely usable"
        );
    }

    /// DF-7 — the deployment artifact. The addresses the script produced are only useful to
    ///        the repository that consumes them if they leave the process, and the salt is
    ///        the one field that cannot be recovered from the chain afterwards: it is what
    ///        ties a whitelist entry made before the deployment to the vault that comes out
    ///        of it. Parsed back rather than string-matched, so a malformed file fails here.
    function test_DF7_WritesADeploymentArtifactCarryingTheSalt() public view {
        string memory raw = vm.readFile(string.concat("deployments/mainnet/", ARTIFACT_KEY, ".json"));

        assertEq(vm.parseJsonUint(raw, ".chainId"), 1, "wrong chain id");
        assertEq(vm.parseJsonBytes32(raw, ".salt"), bytes32(uint256(0xDEF1)), "salt not recorded");
        assertEq(vm.parseJsonAddress(raw, ".safe"), deployedSafe, "safe not recorded");
        assertEq(vm.parseJsonAddress(raw, ".modifier"), deployedModifier, "modifier not recorded");
        assertEq(vm.parseJsonAddress(raw, ".vault"), deployedVault, "vault not recorded");
        assertEq(vm.parseJsonAddress(raw, ".asset"), WETH, "asset not recorded");
        assertEq(vm.parseJsonAddress(raw, ".admin"), FINAL_ADMIN, "admin not recorded");
    }

    /// @dev The 4-byte selector at the head of revert data, assembled rather than cast.
    function _selector(bytes memory data) internal pure returns (bytes4 out) {
        require(data.length >= 4, "revert data carries no selector");
        for (uint256 i = 0; i < 4; i++) {
            out |= bytes4(data[i]) >> (i * 8);
        }
    }

    /// @dev The address argument of a single-address custom error: the 32-byte word after
    ///      the selector.
    function _addressArg(bytes memory data) internal pure returns (address) {
        require(data.length >= 36, "revert data carries no address argument");
        bytes memory word = new bytes(32);
        for (uint256 i = 0; i < 32; i++) {
            word[i] = data[4 + i];
        }
        return abi.decode(word, (address));
    }

    /// @dev A Zodiac module proxy is a minimal proxy: the mastercopy address sits in its
    ///      runtime code. Substring-matching it is enough to tell the two apart.
    function _delegatesTo(address proxy, address mastercopy) internal view returns (bool) {
        bytes memory code = proxy.code;
        bytes20 target = bytes20(mastercopy);
        if (code.length < 20) return false;
        for (uint256 i = 0; i + 20 <= code.length; i++) {
            bool hit = true;
            for (uint256 j = 0; j < 20; j++) {
                if (code[i + j] != target[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}
