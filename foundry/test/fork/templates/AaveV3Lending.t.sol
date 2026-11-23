// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);
    function setUserEMode(uint8 categoryId) external;
}

/// @title  AaveV3LendingRoleMainnetTest
/// @notice Mainnet-fork test for `templates/aave_v3/aave_v3.tmpl` with `borrow: false`.
/// @dev    The lending-only policy must grant approve, supply and withdraw and nothing else on
///         the pool. `borrow`, `repay` and `setUserEMode` are the functions the gate withholds,
///         so each is asserted rejected with otherwise valid parameters. Happy paths use
///         `shouldRevert=false`: the fresh Safe holds nothing, so the pool reverts inside, while
///         a policy rejection would surface as `ConditionViolation`.
contract AaveV3LendingRoleMainnetTest is ZacForkTest {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant BOGUS = 0x000000000000000000000000000000000000dEaD;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    uint8 constant CALL = 0;
    uint256 constant VARIABLE_RATE = 2;
    uint16 constant REFERRAL = 0;
    uint256 constant AMOUNT = 1_000e6;

    /// @dev `encodeKey('AAVE_V3')`: ASCII, right-padded to 32 bytes.
    bytes32 constant ROLE_KEY = 0x414156455f563300000000000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "aave_v3_lending.zac.yaml");
    }

    // ==================== Lending surface: allowed ====================

    function test_approve_happy() public {
        vm.prank(ALICE);
        bool ok = IRoles(modAddr)
            .execTransactionWithRole(
                USDC, 0, abi.encodeCall(IERC20.approve, (AAVE_V3_POOL, AMOUNT)), CALL, ROLE_KEY, true
            );
        assertTrue(ok, "execTransactionWithRole returned false");
        assertEq(IERC20(USDC).allowance(safeAddr, AAVE_V3_POOL), AMOUNT, "Safe -> pool allowance did not update");
    }

    function test_supply_happy() public {
        _assertPolicyAllows(abi.encodeCall(IAaveV3Pool.supply, (USDC, AMOUNT, safeAddr, REFERRAL)));
    }

    function test_withdraw_happy() public {
        _assertPolicyAllows(abi.encodeCall(IAaveV3Pool.withdraw, (USDC, AMOUNT, safeAddr)));
    }

    // ==================== Lending surface: scoped params ====================

    /// supply of an asset outside deposit_assets is rejected.
    function test_supply_wrongAsset_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            AAVE_V3_POOL,
            abi.encodeCall(IAaveV3Pool.supply, (WETH, AMOUNT, safeAddr, REFERRAL)),
            CALL,
            ROLE_KEY
        );
    }

    /// supply on behalf of anyone but the Safe is rejected.
    function test_supply_wrongOnBehalf_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            AAVE_V3_POOL,
            abi.encodeCall(IAaveV3Pool.supply, (USDC, AMOUNT, BOGUS, REFERRAL)),
            CALL,
            ROLE_KEY
        );
    }

    /// withdraw to anyone but the Safe is rejected.
    function test_withdraw_wrongRecipient_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, AAVE_V3_POOL, abi.encodeCall(IAaveV3Pool.withdraw, (USDC, AMOUNT, BOGUS)), CALL, ROLE_KEY
        );
    }

    /// approve to a spender other than the pool is rejected.
    function test_approve_wrongSpender_rejected() public {
        expectPolicyReject(modAddr, ALICE, USDC, abi.encodeCall(IERC20.approve, (BOGUS, AMOUNT)), CALL, ROLE_KEY);
    }

    // ==================== Borrow surface: withheld by the gate ====================

    /// Same parameters the borrow-enabled policy admits. Rejected here because the selector is
    /// not scoped at all.
    function test_borrow_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            AAVE_V3_POOL,
            abi.encodeCall(IAaveV3Pool.borrow, (USDC, AMOUNT, VARIABLE_RATE, REFERRAL, safeAddr)),
            CALL,
            ROLE_KEY
        );
    }

    function test_repay_rejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            AAVE_V3_POOL,
            abi.encodeCall(IAaveV3Pool.repay, (USDC, AMOUNT, VARIABLE_RATE, safeAddr)),
            CALL,
            ROLE_KEY
        );
    }

    function test_setUserEMode_rejected() public {
        expectPolicyReject(
            modAddr, ALICE, AAVE_V3_POOL, abi.encodeCall(IAaveV3Pool.setUserEMode, (uint8(0))), CALL, ROLE_KEY
        );
    }

    // ==================== Helpers ====================

    /// @dev Require the policy to allow `data` on the pool. `shouldRevert=false` swallows the
    ///      pool's own revert into `ok=false`; only a policy rejection reverts.
    function _assertPolicyAllows(bytes memory data) internal {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(AAVE_V3_POOL, 0, data, CALL, ROLE_KEY, false);
    }
}
