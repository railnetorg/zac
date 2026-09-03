// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ZacForkTest, IRoles} from "zac-test/ZacForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Mirrors Morpho Blue's `MarketParams`. Declared locally so the test states the
///      tuple the policy pins, rather than depending on the vendored library's layout.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorpho {
    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;
    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;
    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256);
    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256, uint256);
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
}

/// @title  MorphoBlueRoleMainnetTest
/// @notice Mainnet-fork acceptance test for the collateral and borrow side of
///         `templates/morpho_blue/morpho_blue.tmpl`.
/// @dev    Walks the flow the wstETH-collateral borrow vehicle actually uses: post wstETH,
///         borrow USDC, release collateral at constant debt, then repay in shares mode.
///         `MAINNET_RPC_URL` must be set.
contract MorphoBlueRoleMainnetTest is ZacForkTest {
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WSTETH = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;

    address constant ALICE = 0x1111111111111111111111111111111111111111;
    address constant ATTACKER = 0x2222222222222222222222222222222222222222;
    uint8 constant CALL = 0;

    /// @dev `usdc_wsteth_86` from `aliases/mainnet/morpho_blue.yaml` — the market the
    ///      fixture pins. Any deviation in a field must be rejected by the policy.
    address constant ORACLE = 0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2;
    address constant IRM = 0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC;
    uint256 constant LLTV = 860000000000000000;

    uint256 constant COLLATERAL = 10 ether;
    uint256 constant RELEASE = 1 ether;
    uint256 constant BORROW = 1_000e6;

    /// @dev `encodeKey('MORPHO_BLUE')` — right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x4d4f5250484f5f424c5545000000000000000000000000000000000000000000;

    address safeAddr;
    address modAddr;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));

        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        safeAddr = fx.safe;
        modAddr = fx.modifier_;

        applyConfigFile(fx, ALICE, "morpho_blue.zac.yaml");

        deal(WSTETH, safeAddr, COLLATERAL);
    }

    function _market() internal pure returns (MarketParams memory) {
        return MarketParams({loanToken: USDC, collateralToken: WSTETH, oracle: ORACLE, irm: IRM, lltv: LLTV});
    }

    function _asMember(address to, bytes memory data) internal {
        vm.prank(ALICE);
        IRoles(modAddr).execTransactionWithRole(to, 0, data, CALL, ROLE_KEY, true);
    }

    /// @dev Post collateral and draw USDC — the shared prelude for the exit-side tests.
    function _openPosition() internal {
        _asMember(WSTETH, abi.encodeCall(IERC20.approve, (MORPHO, COLLATERAL)));
        _asMember(MORPHO, abi.encodeCall(IMorpho.supplyCollateral, (_market(), COLLATERAL, safeAddr, bytes(""))));
        _asMember(MORPHO, abi.encodeCall(IMorpho.borrow, (_market(), BORROW, 0, safeAddr, safeAddr)));
    }

    // ==================== Acceptance: allow ====================

    /// TF-1 — happy: the entry. Approve the singleton, post wstETH as collateral, then borrow
    ///        USDC with the receiver pinned to the Safe. Fully executable on a fork, so this
    ///        asserts the money actually moves rather than just the gate decision.
    function test_TF1_RoleMemberCanPostCollateralAndBorrow() public {
        _openPosition();
        assertEq(IERC20(USDC).balanceOf(safeAddr), BORROW, "borrowed USDC did not land in the Safe");
        assertEq(IERC20(WSTETH).balanceOf(safeAddr), 0, "collateral did not leave the Safe");
    }

    /// TF-2 — happy: release collateral at constant debt. This is the move the liquidity
    ///        sleeve relies on — raising LTV to free wstETH without unwinding anything —
    ///        and Morpho itself refuses it if the position would become unhealthy.
    function test_TF2_RoleMemberCanReleaseCollateralAtConstantDebt() public {
        _openPosition();
        _asMember(MORPHO, abi.encodeCall(IMorpho.withdrawCollateral, (_market(), RELEASE, safeAddr, safeAddr)));
        assertEq(IERC20(WSTETH).balanceOf(safeAddr), RELEASE, "released collateral did not return to the Safe");
    }

    /// TF-3 — happy: repay in shares mode. `shares` is deliberately left `pass` on the exit
    ///        directions because it is the only way to close a position exactly; this asserts
    ///        the policy admits it. Repaying every borrow share clears the debt outright.
    function test_TF3_RoleMemberCanRepayInSharesMode() public {
        _openPosition();
        bytes32 id = keccak256(abi.encode(_market()));
        (, uint128 borrowShares,) = IMorpho(MORPHO).position(id, safeAddr);
        assertGt(borrowShares, 0, "no debt to repay");

        // Clearing every share costs the principal plus the interest accrued since the
        // borrow, which the Safe does not hold — it only ever received `BORROW`. Top it up
        // so the assertion is about the policy admitting shares mode, not about funding.
        deal(USDC, safeAddr, BORROW * 2);
        _asMember(USDC, abi.encodeCall(IERC20.approve, (MORPHO, BORROW * 2)));
        _asMember(MORPHO, abi.encodeCall(IMorpho.repay, (_market(), 0, borrowShares, safeAddr, bytes(""))));

        (, uint128 after_,) = IMorpho(MORPHO).position(id, safeAddr);
        assertEq(after_, 0, "shares-mode repay did not clear the debt");
    }

    // ==================== Acceptance: deny ====================

    /// TF-4 — the market is pinned field by field. Swapping the oracle for anything else
    ///        describes a different market, and the policy rejects it even though every other
    ///        field still matches.
    function test_TF4_OffWhitelistMarketRejected() public {
        MarketParams memory foreign = _market();
        foreign.oracle = ATTACKER;
        expectPolicyReject(
            modAddr,
            ALICE,
            MORPHO,
            abi.encodeCall(IMorpho.supplyCollateral, (foreign, COLLATERAL, safeAddr, bytes(""))),
            CALL,
            ROLE_KEY
        );
    }

    /// TF-5 — borrowed assets can only land in the Safe: the receiver is pinned to the avatar,
    ///        so a member cannot draw the vault's credit to their own address.
    function test_TF5_BorrowToForeignReceiverRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            MORPHO,
            abi.encodeCall(IMorpho.borrow, (_market(), BORROW, 0, safeAddr, ATTACKER)),
            CALL,
            ROLE_KEY
        );
    }

    /// TF-6 — entry directions must state the amount: `shares` is pinned to zero on borrow,
    ///        so a share-denominated draw is rejected rather than resolved at execution.
    function test_TF6_BorrowInSharesModeRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            MORPHO,
            abi.encodeCall(IMorpho.borrow, (_market(), 0, 1e18, safeAddr, safeAddr)),
            CALL,
            ROLE_KEY
        );
    }

    /// TF-7 — the Safe can only manage its own position: `onBehalf` is pinned to the avatar,
    ///        so collateral cannot be posted into someone else's account.
    function test_TF7_SupplyCollateralOnBehalfOfForeignAccountRejected() public {
        expectPolicyReject(
            modAddr,
            ALICE,
            MORPHO,
            abi.encodeCall(IMorpho.supplyCollateral, (_market(), COLLATERAL, ATTACKER, bytes(""))),
            CALL,
            ROLE_KEY
        );
    }
}
