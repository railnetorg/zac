// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {DeployLagoonVault, ILagoonVault, ISafe, ILagoonFactory, ILagoonRegistry} from "script/DeployLagoonVault.s.sol";

/// @title  DeployLagoonVaultForkTest
/// @notice Runs `DeployLagoonVault` end to end against mainnet.
/// @dev    A deployment script is only ever run once per vault, by hand, against real money.
///         The failure mode is not a bug that shows up later — it is a vault that exists and
///         is wrong. So the script's entry point is exercised here rather than its parts:
///         same `run()`, same env vars, same factories.
///
///         What it pins is the set of defaults that are wrong. A vault deployed without
///         naming the logic comes out v0.5.0; a v0.6.0 vault initializes to `SyncMode.Both`
///         with both sync entrypoints open; the legacy struct overload on the factory cannot
///         encode a v0.6.0 initializer at all. Each is a live default, and each would produce
///         a vault the `ERC7540Vehicle` cannot legitimately wrap.
///
///         `MAINNET_RPC_URL` must be set.
contract DeployLagoonVaultForkTest is Test {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant OWNER = 0x1111111111111111111111111111111111111111;
    address constant VALUATION_MANAGER = 0x2222222222222222222222222222222222222222;

    address constant LAGOON_FACTORY = 0x8D6f5479B14348186faE9BC7E636e947c260f9B1;
    address constant LAGOON_LOGIC_V0_6_0 = 0x6C77c47FB8168E22976C3B0338CB1769c952249f;
    address constant LAGOON_LOGIC_V0_5_0 = 0xE50554ec802375C9c3F9c087a8a7bb8C26d3DEDf;
    address constant ROLES_MASTERCOPY_PATCHED = 0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5;
    address constant ROLES_MASTERCOPY_PRE_PATCH = 0x9646fDAD06d3e24444381f44362a3B0eB343D337;

    uint8 constant SYNC_MODE_NONE = 3;

    DeployLagoonVault script_;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));
        script_ = new DeployLagoonVault();

        vm.setEnv("SAFE_OWNER", vm.toString(OWNER));
        vm.setEnv("VAULT_UNDERLYING", vm.toString(WETH));
        vm.setEnv("VAULT_NAME", "Railnet Test WETH");
        vm.setEnv("VAULT_SYMBOL", "rnTWETH");
        vm.setEnv("VAULT_VALUATION_MANAGER", vm.toString(VALUATION_MANAGER));
        vm.setEnv("DEPLOY_SALT", vm.toString(bytes32(uint256(0xDEF1))));
    }

    /// DF-1 — the whole run. Every invariant the script asserts internally is re-asserted
    ///        here against the deployed addresses, so a `require` quietly removed from the
    ///        script fails this test rather than shipping.
    function test_DF1_DeploysAnAsyncOnlyV060VaultCuratedByTheSafe() public {
        script_.run();

        (address safe, address modifier_, address vault) = script_.deployed();
        assertTrue(safe != address(0) && modifier_ != address(0) && vault != address(0), "nothing deployed");

        assertEq(ILagoonVault(vault).version(), "v0.6.0", "vault is not on the v0.6.0 logic");
        assertEq(ILagoonVault(vault).syncMode(), SYNC_MODE_NONE, "vault is not pinned async-only");
        assertEq(ILagoonVault(vault).asset(), WETH, "vault underlying is wrong");
        assertEq(ILagoonVault(vault).safe(), safe, "vault is not curated by the deployed Safe");
        assertTrue(ILagoonFactory(LAGOON_FACTORY).isInstance(vault), "vault is not a factory instance");

        assertTrue(ISafe(safe).isOwner(OWNER), "owner is not an owner");
        assertEq(ISafe(safe).getThreshold(), 1, "threshold is not 1");
        assertTrue(ISafe(safe).isModuleEnabled(modifier_), "modifier is not enabled on the Safe");
    }

    /// DF-2 — the modifier runs the post-advisory mastercopy. The June 2026 Zodiac advisory
    ///        (Roles Modifier v2; an ERC-1271 check that read the returned magic value without
    ///        checking the call succeeded) was fixed by a redeploy, so the only thing
    ///        separating a patched modifier from a vulnerable one is which address the module
    ///        proxy points at. Read out of the proxy's own runtime rather than trusted.
    function test_DF2_ModifierPointsAtThePatchedMastercopy() public {
        script_.run();
        (, address modifier_,) = script_.deployed();

        assertTrue(_delegatesTo(modifier_, ROLES_MASTERCOPY_PATCHED), "modifier is not on the patched mastercopy");
        assertFalse(_delegatesTo(modifier_, ROLES_MASTERCOPY_PRE_PATCH), "modifier is on the pre-patch mastercopy");
    }

    /// DF-3 — the default is the wrong one. If the registry ever makes v0.6.0 the default this
    ///        test starts failing, which is the moment to simplify the script; until then it
    ///        records why the logic is named explicitly.
    function test_DF3_RegistryDefaultIsStillV050() public view {
        address registry = ILagoonFactory(LAGOON_FACTORY).registry();
        assertEq(ILagoonRegistry(registry).defaultLogic(), LAGOON_LOGIC_V0_5_0, "registry default changed");
        assertTrue(
            ILagoonRegistry(registry).canUseLogic(OWNER, LAGOON_LOGIC_V0_6_0), "v0.6.0 is no longer freely usable"
        );
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
