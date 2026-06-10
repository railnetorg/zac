// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

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
/// @dev    `deployRolesFixture` stands up a Safe + Roles V2 Modifier; `applyConfigFile`
///         renders + applies the `policy.zac.yaml` fixture against the fresh Modifier. The
///         test functions assert the Modifier's allow/deny decision for in-policy and
///         off-policy `executeLoop` calldata. `RPC_URL` must be set.
contract HelperRoleMainnetTest is ZacForkTest {
    // Mainnet protocol addresses referenced by the policy + assertions.
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    /// @dev The policy's scoped target — the Helper singleton (`aliases.helper.singleton`).
    ///      The allow/deny decision is calldata-based, so this address need not host bytecode
    ///      for these assertions; a permitted call is forwarded to the Safe.
    address constant HELPER = 0x000000000000000000000000000000000000c0DE;
    uint8 constant DELEGATECALL = 1;
    uint256 constant FLASH_AMOUNT = 1_000e6;
    uint256 constant MIN_HF_VALID = 1.1e18;

    /// @dev `encodeKey('FLASH_LOAN_HELPER')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x464c4153485f4c4f414e5f48454c504552000000000000000000000000000000;

    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "helper.zac.yaml");
    }

    // ==================== Acceptance: allow / deny ====================

    /// TF-1 — happy: role member calls executeLoop via DELEGATECALL with whitelisted params.
    ///        `shouldRevert=false` swallows any inner result; we only assert the Modifier did
    ///        not reject at the policy gate.
    function test_TF1_RoleMemberCanCallExecuteLoopWithValidParams() public {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(HELPER, 0, _cd(_validParams()), DELEGATECALL, ROLE_KEY, false);
    }

    /// TF-2 — sad: lendingVenue is not the Aave V3 Pool.
    function test_TF2_WrongLendingVenueRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.lendingVenue = address(0xdead);
        _expectPolicyReject(p);
    }

    /// TF-3 — sad: asset off the per-vehicle whitelist (config allows USDC only).
    function test_TF3_OffWhitelistAssetRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.asset = WETH;
        _expectPolicyReject(p);
    }

    /// TF-4 — sad: flashVenue not in `allowed_flash_venues`.
    function test_TF4_OffWhitelistFlashVenueRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.flashVenue = address(0xbeef);
        _expectPolicyReject(p);
    }

    /// TF-5 — sad: minHealthFactor at or below the per-vehicle floor (strict gt against
    ///        1099999999999999999, so 1e18 is rejected).
    function test_TF5_HealthFactorBelowFloorRejected() public {
        IFlashLoanHelper.LoopParams memory p = _validParams();
        p.minHealthFactor = 1e18;
        _expectPolicyReject(p);
    }

    // ==================== Helpers ====================

    /// @dev Assert the Modifier rejects a DELEGATECALL of `executeLoop(p)` at the policy gate.
    function _expectPolicyReject(IFlashLoanHelper.LoopParams memory p) internal {
        expectPolicyReject(modAddr, ALICE, HELPER, _cd(p), DELEGATECALL, ROLE_KEY);
    }

    function _cd(IFlashLoanHelper.LoopParams memory p) internal pure returns (bytes memory) {
        return abi.encodeCall(IFlashLoanHelper.executeLoop, (p));
    }

    /// Whitelisted params: USDC loop, Morpho flash, HF floor satisfied.
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
}
