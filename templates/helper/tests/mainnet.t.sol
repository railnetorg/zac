// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest} from "zac-test/ZacForkTest.sol";
import {ISafe} from "@safe/interfaces/ISafe.sol";
import {IModuleManager} from "@safe/interfaces/IModuleManager.sol";
import {Enum} from "@safe/interfaces/Enum.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @dev Zodiac canonical ModuleProxyFactory — CREATE2-deploys an EIP-1167 proxy
///      pointing at `masterCopy` and atomically calls it with `initializer`.
interface IModuleProxyFactory {
    function deployModule(address masterCopy, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface IRoles {
    function setUp(bytes memory initParams) external;
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool success);
}

/// @dev Local copy of LoopParams (mirrors `foundry/src/interfaces/IFlashLoanHelper.sol`).
interface IFlashLoanHelper {
    enum LoopDirection {
        Boost,
        Repay
    }
    enum FlashVenueKind {
        Aave,
        Morpho
    }

    struct LoopParams {
        LoopDirection direction;
        address lendingVenue;
        address asset;
        uint256 flashAmount;
        address flashVenue;
        FlashVenueKind flashVenueKind;
        uint256 minHealthFactor;
    }

    function executeLoop(LoopParams calldata p) external;
}

/// @title  HelperRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the `templates/helper/helper.tmpl` policy.
/// @dev    setUp deploys a fresh Safe via the on-chain SafeProxyFactory and a fresh
///         Roles V2 Modifier via Zodiac's ModuleProxyFactory, materialises a
///         deployment config under `/tmp/zac-helper-test/mainnet/<safeAddr>/` baked
///         with the resulting addresses, then runs `zacApply` to render the policy
///         from `helper.tmpl` and apply the role-state updates on the Modifier.
///
///         The test functions assert the Modifier's allow/deny decision for
///         in-policy and off-policy `executeLoop` calldata against the fresh policy.
contract HelperRoleMainnetTest is ZacForkTest {
    // --- Mainnet factories + mastercopies ---
    address constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant MODULE_PROXY_FACTORY = 0x000000000000aDdB49795b0f9bA5BC298cDda236;
    /// @dev Roles V2 v2.1.0 mastercopy (CREATE2-deterministic via EIP-2470).
    address constant ROLES_MASTERCOPY = 0x9646fDAD06d3e24444381f44362a3B0eB343D337;

    // --- Mainnet protocol addresses (referenced in the policy + assertions) ---
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    // --- Test fixture ---
    address constant ALICE = 0x1111111111111111111111111111111111111111;
    /// @dev Policy target address. The Modifier's gate check is calldata-based, so
    ///      the address need not host real bytecode for the allow/deny assertions to
    ///      be meaningful — the inner DELEGATECALL is allowed to no-op against empty
    ///      code under `shouldRevert=false`.
    address constant HELPER_SENTINEL = 0x000000000000000000000000000000000000c0DE;
    uint256 constant FLASH_AMOUNT = 1_000e6;
    uint256 constant MIN_HF_VALID = 1.1e18;

    /// @dev `encodeKey('FLASH_LOAN_HELPER')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x464c4153485f4c4f414e5f48454c504552000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        uint256 startBlock = block.number;

        // Randomised salt so concurrent / repeated runs don't collide on the same
        // CREATE2 address.
        uint256 saltNonce = vm.randomUint();
        bytes memory safeSetupInit = _safeSetupInitializer();

        // Predict the proxy addresses with read-only eth_call against anvil. We must
        // NOT deploy in forge's in-process EVM: that would give safeAddr code locally,
        // and forge rejects eth_sendTransaction from a code-bearing sender (EIP-3607)
        // before forwarding to anvil. The real deployments happen on anvil below.
        bytes memory createCd =
            abi.encodeCall(ISafeProxyFactory.createProxyWithNonce, (SAFE_SINGLETON, safeSetupInit, saltNonce));
        safeAddr = abi.decode(_anvilCall(SAFE_PROXY_FACTORY, createCd), (address));

        bytes memory modSetUpInit = abi.encodeCall(IRoles.setUp, (abi.encode(safeAddr, safeAddr, safeAddr)));
        bytes memory deployCd =
            abi.encodeCall(IModuleProxyFactory.deployModule, (ROLES_MASTERCOPY, modSetUpInit, saltNonce));
        modAddr = abi.decode(_anvilCall(MODULE_PROXY_FACTORY, deployCd), (address));

        // Anvil-side deployments — must happen here because `zac plan` queries the
        // RPC node (anvil), not forge's in-process EVM. Two mined blocks: deploy
        // Safe + Modifier first, then enable the modules (which require the prior
        // block's contracts to exist). Mining per-phase keeps cross-sender tx
        // ordering deterministic.
        vm.rpc("evm_setAutomine", "[false]");

        // Phase 1 — deploy the Safe and Modifier proxies (sent by ALICE).
        _anvilFundAndImpersonate(ALICE);
        _anvilSendTx(
            ALICE,
            SAFE_PROXY_FACTORY,
            abi.encodeCall(ISafeProxyFactory.createProxyWithNonce, (SAFE_SINGLETON, safeSetupInit, saltNonce))
        );
        _anvilSendTx(
            ALICE,
            MODULE_PROXY_FACTORY,
            abi.encodeCall(IModuleProxyFactory.deployModule, (ROLES_MASTERCOPY, modSetUpInit, saltNonce))
        );
        vm.rpc("anvil_mine", "[]");
        _anvilStopImpersonating(ALICE);

        // Phase 2 — as the Safe (owner of both): enable the Modifier on the Safe so
        // it can relay calls, and enable ALICE on the Modifier so she clears its
        // `moduleOnly` gate when calling execTransactionWithRole.
        _anvilFundAndImpersonate(safeAddr);
        _anvilSendTx(safeAddr, safeAddr, abi.encodeCall(IModuleManager.enableModule, (modAddr)));
        _anvilSendTx(safeAddr, modAddr, abi.encodeCall(IModuleManager.enableModule, (ALICE)));
        vm.rpc("anvil_mine", "[]");
        _anvilStopImpersonating(safeAddr);

        vm.rpc("evm_setAutomine", "[true]");
        vm.rollFork(startBlock + 2);

        string memory configPath = _writeTestConfig();
        string memory rootConfigPath = string.concat(vm.projectRoot(), "/../examples/config.yaml");
        zacApply(configPath, rootConfigPath);
    }

    // ==================== Acceptance: allow / deny ====================

    /// TF-1 — happy: role member calls executeLoop via DELEGATECALL with whitelisted
    ///        params. `shouldRevert=false` swallows any inner revert; we only assert
    ///        the Modifier did not reject at the policy gate.
    function test_TF1_RoleMemberCanCallExecuteLoopWithValidParams() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        bytes memory cd = abi.encodeCall(IFlashLoanHelper.executeLoop, (p));

        vm.prank(ALICE);
        IRoles(modAddr)
            .execTransactionWithRole(HELPER_SENTINEL, 0, cd, uint8(Enum.Operation.DelegateCall), ROLE_KEY, false);
    }

    /// TF-2 — sad: lendingVenue is not the Aave V3 Pool.
    function test_TF2_WrongLendingVenueRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.lendingVenue = address(0xdead);
        bytes memory cd = abi.encodeCall(IFlashLoanHelper.executeLoop, (p));

        vm.prank(ALICE);
        vm.expectRevert();
        IRoles(modAddr)
            .execTransactionWithRole(HELPER_SENTINEL, 0, cd, uint8(Enum.Operation.DelegateCall), ROLE_KEY, false);
    }

    /// TF-3 — sad: asset off the per-vehicle whitelist (config allows USDC only).
    function test_TF3_OffWhitelistAssetRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.asset = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // WETH; off whitelist
        bytes memory cd = abi.encodeCall(IFlashLoanHelper.executeLoop, (p));

        vm.prank(ALICE);
        vm.expectRevert();
        IRoles(modAddr)
            .execTransactionWithRole(HELPER_SENTINEL, 0, cd, uint8(Enum.Operation.DelegateCall), ROLE_KEY, false);
    }

    /// TF-4 — sad: flashVenue not in `allowed_flash_venues`.
    function test_TF4_OffWhitelistFlashVenueRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.flashVenue = address(0xbeef);
        bytes memory cd = abi.encodeCall(IFlashLoanHelper.executeLoop, (p));

        vm.prank(ALICE);
        vm.expectRevert();
        IRoles(modAddr)
            .execTransactionWithRole(HELPER_SENTINEL, 0, cd, uint8(Enum.Operation.DelegateCall), ROLE_KEY, false);
    }

    /// TF-5 — sad: minHealthFactor at or below the per-vehicle floor.
    function test_TF5_HealthFactorBelowFloorRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.minHealthFactor = 1e18;
        bytes memory cd = abi.encodeCall(IFlashLoanHelper.executeLoop, (p));

        vm.prank(ALICE);
        vm.expectRevert();
        IRoles(modAddr)
            .execTransactionWithRole(HELPER_SENTINEL, 0, cd, uint8(Enum.Operation.DelegateCall), ROLE_KEY, false);
    }

    // ==================== Helpers ====================

    function _validParams() internal pure returns (IFlashLoanHelper.LoopParams memory) {
        return IFlashLoanHelper.LoopParams({
            direction: IFlashLoanHelper.LoopDirection.Boost,
            lendingVenue: AAVE_V3_POOL,
            asset: USDC,
            flashAmount: FLASH_AMOUNT,
            flashVenue: MORPHO,
            flashVenueKind: IFlashLoanHelper.FlashVenueKind.Morpho,
            minHealthFactor: MIN_HF_VALID
        });
    }

    function _safeSetupInitializer() internal pure returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = ALICE;
        return
            abi.encodeCall(
                ISafe.setup, (owners, 1, address(0), bytes(""), address(0), address(0), 0, payable(address(0)))
            );
    }

    function _writeTestConfig() internal returns (string memory configPath) {
        // Write under foundry's `cache/` so the layout is OS-independent and the
        // artefacts are gitignored alongside other build cache files.
        string memory configDir =
            string.concat(vm.projectRoot(), "/cache/zac-helper-test/mainnet/", vm.toString(safeAddr));
        // mkdir -p the layout the CLI expects.
        string[] memory mkdirCmd = new string[](3);
        mkdirCmd[0] = "mkdir";
        mkdirCmd[1] = "-p";
        mkdirCmd[2] = configDir;
        vm.ffi(mkdirCmd);

        string memory templateAbs = string.concat(vm.projectRoot(), "/../templates/helper/helper.tmpl");

        string memory cfg = string.concat(
            "roles_modifier_address: \"",
            vm.toString(modAddr),
            "\"\n",
            "safe_address: \"",
            vm.toString(safeAddr),
            "\"\n",
            "chain_id: 1\n",
            "name: Helper Role Test\n",
            "description: Materialised by HelperRoleMainnetTest at setUp time.\n",
            "configs:\n",
            "  - template: \"",
            templateAbs,
            "\"\n",
            "    key: FLASH_LOAN_HELPER\n",
            "    members:\n",
            "      - \"",
            vm.toString(ALICE),
            "\"\n",
            "    params:\n",
            "      assets: [\"USDC\"]\n",
            "      allowed_flash_venues: [\"aave\", \"morpho\"]\n",
            "      min_health_factor_floor: \"1099999999999999999\"\n"
        );
        configPath = string.concat(configDir, "/test.zac.yaml");
        vm.writeFile(configPath, cfg);
    }

    // --- anvil RPC plumbing ---

    function _anvilFundAndImpersonate(address addr) internal {
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
}
