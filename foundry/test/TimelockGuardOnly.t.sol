// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import {Test} from "forge-std/Test.sol";
import {Safe} from "@safe-contracts/Safe.sol";
import {TimelockGuardOnly} from "../src/guards/TimeLock.guard.sol";

/// @notice Minimal mock returning the two pieces of Safe state the
///         `TimelockGuard.configureTimelockGuard` path reads:
///           - `VERSION()` (string)            for the 1.4.1 version gate
///           - `getStorageAt(slot, len)` (bytes) for the `_isGuardEnabled` check
///         Everything else stays at default. The mock is deployed at the
///         address whose msg.sender the guard contract sees, so its own
///         storage of `guardSlot` IS what `_isGuardEnabled` reads back.
contract MockSafe {
    address internal guardSlot;
    string internal versionString;

    constructor() {
        versionString = "1.4.1";
    }

    function VERSION() external view returns (string memory) {
        return versionString;
    }

    function setMockVersion(string calldata v) external {
        versionString = v;
    }

    function setMockGuard(address g) external {
        guardSlot = g;
    }

    /// @dev TimelockGuard reads `abi.decode(.getStorageAt(GUARD_STORAGE_SLOT, 1), (address))`.
    ///      We ignore the slot/length args and return our stored value so tests
    ///      can flip "guard enabled vs not" without computing the real slot.
    function getStorageAt(uint256, uint256) external view returns (bytes memory) {
        return abi.encode(guardSlot);
    }

    /// @dev Lets the test invoke `guard.configureTimelockGuard(delay)` so that
    ///      `msg.sender` on the guard side is THIS mock — no `vm.prank` needed.
    function callConfigure(TimelockGuardOnly guard, uint256 delay) external {
        guard.configureTimelockGuard(delay);
    }
}

contract TimelockGuardOnlyTest is Test {
    TimelockGuardOnly internal guard;
    MockSafe internal safeMock;

    function setUp() public {
        guard = new TimelockGuardOnly();
        safeMock = new MockSafe();
        safeMock.setMockGuard(address(guard));
    }

    function test_version() public view {
        assertEq(guard.version(), "1.0.0");
    }

    function test_deployedNotZero() public view {
        assertTrue(address(guard) != address(0));
    }

    function test_configure_setsDelay() public {
        safeMock.callConfigure(guard, 1 days);
        assertEq(guard.timelockDelay(Safe(payable(address(safeMock)))), 1 days);
    }

    function test_configure_reconfigureOverwrites() public {
        safeMock.callConfigure(guard, 1 days);
        safeMock.callConfigure(guard, 7 days);
        assertEq(guard.timelockDelay(Safe(payable(address(safeMock)))), 7 days);
    }

    function test_configure_revertsOnWrongSafeVersion() public {
        safeMock.setMockVersion("1.3.0");
        vm.expectRevert(); // TimelockGuard_InvalidVersion
        safeMock.callConfigure(guard, 1 days);
    }

    function test_configure_revertsWhenGuardNotEnabled() public {
        safeMock.setMockGuard(address(0xdead));
        vm.expectRevert(); // TimelockGuard_GuardNotEnabled
        safeMock.callConfigure(guard, 1 days);
    }

    function test_configure_revertsOnZeroDelay() public {
        vm.expectRevert(); // TimelockGuard_InvalidTimelockDelay
        safeMock.callConfigure(guard, 0);
    }

    function test_configure_revertsOnDelayOverOneYear() public {
        vm.expectRevert(); // TimelockGuard_InvalidTimelockDelay
        safeMock.callConfigure(guard, 365 days + 1);
    }

    function test_configure_acceptsExactlyOneYear() public {
        safeMock.callConfigure(guard, 365 days);
        assertEq(guard.timelockDelay(Safe(payable(address(safeMock)))), 365 days);
    }

    /// `_checkCombinedConfig` is the override-point of TimelockGuardOnly. The
    /// base calls it at the end of configureTimelockGuard; a non-no-op
    /// override could revert here. Our override is empty, so this is just an
    /// observable assertion that configuration succeeds with no extension
    /// coordination needed.
    function test_checkCombinedConfig_isNoOp() public {
        safeMock.callConfigure(guard, 30 days);
        // Reaching this line is the assertion — no revert from the hook.
        assertEq(guard.timelockDelay(Safe(payable(address(safeMock)))), 30 days);
    }
}
