// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MilkmanSwapManager, IMilkman} from "src/MilkmanSwapManager.sol";

/// @title  MilkmanSwapManagerForkTest
/// @notice Mainnet-fork integration test against the REAL deployed Milkman
///         (`0x060373…E88`). It exercises the deployed 7-parameter `appData` ABI end-to-end:
///         `openSwap` binds the real CREATE clone and escrows the sell token, and `cancelSwap`
///         clears the real creator-proof — which only passes if the replayed param tuple (incl.
///         `appData`) matches the clone's stored swap hash — and reclaims to the Safe. This is the
///         integration coverage whose absence let the wrong (6-param) ABI ship a false green.
/// @dev    Requires `MAINNET_RPC_URL`; run under `FOUNDRY_PROFILE=contracts-fork`.
contract MilkmanSwapManagerForkTest is Test {
    address constant MILKMAN = 0x060373D064d0168931dE2AB8DDA7410923d06E88;
    address constant PRICE_CHECKER = 0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c;
    IERC20 constant USDC = IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    IERC20 constant PYUSD = IERC20(0x6c3ea9036406852006290770BEdFcAbA0e23A0e8);

    address SAFE = makeAddr("safe");
    address KEEPER = makeAddr("keeper");
    bytes32 constant APP_DATA = keccak256("railnet-rwa");
    uint256 constant AMOUNT = 1_000e6;

    MilkmanSwapManager manager;

    function setUp() public {
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"));
        manager = new MilkmanSwapManager(IMilkman(MILKMAN), SAFE, KEEPER);
        deal(address(USDC), SAFE, AMOUNT);
        vm.prank(SAFE);
        USDC.approve(address(manager), type(uint256).max);
    }

    function _open() internal returns (address clone) {
        clone = vm.computeCreateAddress(MILKMAN, vm.getNonce(MILKMAN));
        vm.prank(KEEPER);
        manager.openSwap(AMOUNT, USDC, PYUSD, APP_DATA, PRICE_CHECKER, "", clone);
    }

    function test_fork_openBindsRealCloneAndEscrows() public {
        address clone = _open();
        assertGt(clone.code.length, 0, "real clone deployed at the predicted address");
        assertEq(USDC.balanceOf(clone), AMOUNT, "escrow landed in the real clone");
        assertEq(USDC.balanceOf(SAFE), 0, "pulled from the Safe");
        assertTrue(manager.isPending());
    }

    function test_fork_cancelClearsCreatorProofAndReclaims() public {
        _open();
        // Reverts unless the replayed params (incl. appData) match the clone's real swap hash.
        vm.prank(KEEPER);
        manager.cancelSwap();
        assertEq(USDC.balanceOf(SAFE), AMOUNT, "reclaimed to the Safe via the real cancelSwap");
        assertEq(USDC.balanceOf(address(manager)), 0, "manager holds nothing");
        assertFalse(manager.isPending());
    }
}
