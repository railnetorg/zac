// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MilkmanSwapManager, IMilkman} from "src/MilkmanSwapManager.sol";

// --------------------------------------------------------------------------------------------
// Mocks — a stand-in for Milkman's root + per-order clone, on the DEPLOYED 7-param ABI (with
// `bytes32 appData`). The clone is created via CREATE (so its address is
// `vm.computeCreateAddress(milkman, nonce)`, exactly what the keeper predicts on mainnet), holds
// the escrow, and refunds `amountIn` to the creator on cancel. A fill is simulated in tests with
// `deal(fromToken, clone, 0)` (CoW pulls the sell token out).
//
// NB: these are unit-level checks of the manager's internal logic; the mock's swap-hash layout is
// self-consistent but not asserted to match mainnet. The mainnet-fork test
// (test/fork/MilkmanSwapManagerFork.t.sol) is what pins the real deployed ABI + swap-hash.
// --------------------------------------------------------------------------------------------

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockMilkmanOrder {
    bytes32 public swapHash;

    function initialize(bytes32 h) external {
        require(swapHash == bytes32(0), "already-init");
        swapHash = h;
    }

    // Mirrors Milkman: recompute the swap hash from the full param tuple (incl. appData) and refund
    // `amountIn` to the caller (must be the original creator).
    function cancelSwap(
        uint256 amountIn,
        IERC20 fromToken,
        IERC20 toToken,
        address to,
        bytes32 appData,
        address priceChecker,
        bytes calldata priceCheckerData
    ) external {
        bytes32 h = keccak256(
            abi.encode(msg.sender, to, fromToken, toToken, amountIn, appData, priceChecker, priceCheckerData)
        );
        require(h == swapHash, "!creator");
        fromToken.transfer(msg.sender, amountIn);
    }
}

contract MockMilkman {
    function requestSwapExactTokensForTokens(
        uint256 amountIn,
        IERC20 fromToken,
        IERC20 toToken,
        address to,
        bytes32 appData,
        address priceChecker,
        bytes calldata priceCheckerData
    ) external {
        MockMilkmanOrder order = new MockMilkmanOrder(); // CREATE — address tracks this contract's nonce
        fromToken.transferFrom(msg.sender, address(order), amountIn);
        order.initialize(
            keccak256(abi.encode(msg.sender, to, fromToken, toToken, amountIn, appData, priceChecker, priceCheckerData))
        );
    }
}

// --------------------------------------------------------------------------------------------

contract MilkmanSwapManagerTest is Test {
    MockERC20 fromToken;
    MockERC20 toToken;
    MockMilkman milkman;
    MilkmanSwapManager manager;

    address SAFE = makeAddr("safe");
    address STRANGER = makeAddr("stranger");
    address PRICE_CHECKER = makeAddr("priceChecker");
    bytes32 APP_DATA = keccak256("railnet-rwa");
    bytes PC_DATA = hex"1234";

    uint256 constant AMOUNT = 1_000e6;
    uint256 constant SAFE_FUNDS = 1_000_000e6;

    function setUp() public {
        fromToken = new MockERC20("USD Coin", "USDC", 6);
        toToken = new MockERC20("Ondo GM SPY", "SPYon", 18);
        milkman = new MockMilkman();
        manager = new MilkmanSwapManager(IMilkman(address(milkman)), SAFE);

        fromToken.mint(SAFE, SAFE_FUNDS);
        vm.prank(SAFE);
        fromToken.approve(address(manager), type(uint256).max);
    }

    // Predict the next clone Milkman will deploy, then open through the keeper.
    function _open(uint256 amountIn) internal returns (address clone) {
        clone = vm.computeCreateAddress(address(milkman), vm.getNonce(address(milkman)));
        vm.prank(SAFE);
        manager.openSwap(amountIn, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, clone);
    }

    function _simulateFill(address clone) internal {
        deal(address(fromToken), clone, 0); // CoW pulls the sell token; receiver already got the buy token
    }

    // ---- openSwap: binding + escrow ----------------------------------------------------------

    function test_openSwap_bindsCloneAndEscrows() public {
        address clone = _open(AMOUNT);

        assertEq(fromToken.balanceOf(clone), AMOUNT, "escrow in clone");
        assertEq(fromToken.balanceOf(SAFE), SAFE_FUNDS - AMOUNT, "pulled from Safe");
        assertTrue(manager.isPending(), "pending after open");

        MilkmanSwapManager.PendingOrder memory p = manager.pendingOrder();
        assertEq(p.clone, clone);
        assertEq(p.amountIn, AMOUNT);
        assertEq(address(p.fromToken), address(fromToken));
        assertEq(address(p.toToken), address(toToken));
        assertEq(p.appData, APP_DATA);
        assertEq(p.priceChecker, PRICE_CHECKER);
        assertEq(p.priceCheckerData, PC_DATA);
    }

    function test_openSwap_revertsOnWrongExpectedAddress() public {
        // Predict correctly but pass a different (empty) address → the post-call code check fails.
        vm.prank(SAFE);
        vm.expectRevert(MilkmanSwapManager.CloneNotCreated.selector);
        manager.openSwap(AMOUNT, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, address(0xBEEF));

        // Nothing persisted: the whole tx (incl. the pull + clone deploy) rolled back.
        assertEq(fromToken.balanceOf(SAFE), SAFE_FUNDS);
        assertFalse(manager.isPending());
    }

    function test_openSwap_revertsWhenExpectedAlreadyHasCode() public {
        // An address that already holds code (a stale-nonce race would land here) is rejected up front.
        vm.prank(SAFE);
        vm.expectRevert(MilkmanSwapManager.CloneAlreadyExists.selector);
        manager.openSwap(AMOUNT, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, address(milkman));
    }

    function test_openSwap_revertsWhenPending() public {
        _open(AMOUNT);
        address next = vm.computeCreateAddress(address(milkman), vm.getNonce(address(milkman)));
        vm.prank(SAFE);
        vm.expectRevert(MilkmanSwapManager.OrderPending.selector);
        manager.openSwap(AMOUNT, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, next);
    }

    function test_openSwap_revertsForNonSafe() public {
        vm.prank(STRANGER);
        vm.expectRevert(MilkmanSwapManager.NotSafe.selector);
        manager.openSwap(AMOUNT, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, address(0xBEEF));
    }

    function test_openSwap_revertsOnZeroAmount() public {
        vm.prank(SAFE);
        vm.expectRevert(MilkmanSwapManager.ZeroAmount.selector);
        manager.openSwap(0, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, address(0xBEEF));
    }

    // ---- quiescence gate + donation safety ---------------------------------------------------

    function test_isPending_flipsToFalseOnFill() public {
        address clone = _open(AMOUNT);
        assertTrue(manager.isPending());
        _simulateFill(clone);
        assertFalse(manager.isPending(), "quiescent after fill");
    }

    function test_donation_belowAmountIn_isIgnored() public {
        address clone = _open(AMOUNT);
        _simulateFill(clone);
        deal(address(fromToken), clone, AMOUNT - 1); // donation strictly below the sell amount

        assertFalse(manager.isPending(), "sub-amountIn donation ignored");

        // A new swap can be opened — the settled clone does not gate it.
        address next = vm.computeCreateAddress(address(milkman), vm.getNonce(address(milkman)));
        vm.prank(SAFE);
        manager.openSwap(AMOUNT, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, next);
        assertTrue(manager.isPending());
    }

    function test_donation_atAmountIn_jams_boundedDoS() public {
        address clone = _open(AMOUNT);
        _simulateFill(clone);
        deal(address(fromToken), clone, AMOUNT); // to jam, an attacker must strand a FULL amountIn

        assertTrue(manager.isPending(), "gate over-blocks (safe direction)");

        address next = vm.computeCreateAddress(address(milkman), vm.getNonce(address(milkman)));
        vm.prank(SAFE);
        vm.expectRevert(MilkmanSwapManager.OrderPending.selector);
        manager.openSwap(AMOUNT, fromToken, toToken, APP_DATA, PRICE_CHECKER, PC_DATA, next);
    }

    // ---- cancelSwap ----------------------------------------------------------------------------

    function test_cancelSwap_reclaimsToSafe() public {
        address clone = _open(AMOUNT);
        assertEq(fromToken.balanceOf(SAFE), SAFE_FUNDS - AMOUNT);

        vm.prank(SAFE);
        manager.cancelSwap();

        assertEq(fromToken.balanceOf(SAFE), SAFE_FUNDS, "fully reclaimed to Safe");
        assertEq(fromToken.balanceOf(clone), 0);
        assertEq(fromToken.balanceOf(address(manager)), 0, "manager holds nothing");
        assertFalse(manager.isPending());
        assertEq(manager.pendingOrder().clone, address(0), "pending cleared");
    }

    function test_cancelSwap_revertsWhenNoPending() public {
        vm.prank(SAFE);
        vm.expectRevert(MilkmanSwapManager.NoPendingOrder.selector);
        manager.cancelSwap();
    }

    function test_cancelSwap_revertsForNonSafe() public {
        _open(AMOUNT);
        vm.prank(STRANGER);
        vm.expectRevert(MilkmanSwapManager.NotSafe.selector);
        manager.cancelSwap();
    }

    function test_cancelSwap_afterFill_revertsAsNoPending() public {
        address clone = _open(AMOUNT);
        _simulateFill(clone); // filled between the keeper's decision and the cancel

        vm.prank(SAFE);
        vm.expectRevert(MilkmanSwapManager.NoPendingOrder.selector);
        manager.cancelSwap();
    }
}
