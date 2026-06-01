// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

// Safe
import {Safe} from "@safe-contracts/Safe.sol";

// Safe Extensions
import {TimelockGuard} from "@optimism-contracts/safe/TimelockGuard.sol";
import {ISemver} from "@optimism-interfaces/universal/ISemver.sol";

/// @title TimelockGuardOnly
/// @notice Minimal concrete implementation of the abstract `TimelockGuard`.
///         Provides a singleton timelock guard that any Safe (v1.4.1) on the
///         network can install to enforce a configurable delay between
///         transaction scheduling and execution, with permissionless
///         cancellation during the delay.
/// @dev This implementation deliberately does NOT include `LivenessModule2`.
///      If you also need fallback-owner recovery in case of quorum loss, use
///      `SaferSafes` instead.
///
///      Installation flow (must be batched in a single Safe tx to avoid the
///      window where guard is enabled with delay = 0):
///        1. Safe.setGuard(<this contract>)
///        2. TimelockGuardOnly.configureTimelockGuard(<delay seconds>)
///
///      Compatible only with Safe contract version 1.4.1 (enforced by
///      `TimelockGuard`'s version check at configuration time).
contract TimelockGuardOnly is TimelockGuard, ISemver {
    /// @notice Semantic version.
    /// @custom:semver 1.0.0
    string public constant version = "1.0.0";

    /// @notice No-op override of the combined-config invariant hook.
    /// @dev `TimelockGuard` calls this at the end of any configuration
    ///      function. In `SaferSafes`, this hook enforces an invariant
    ///      between the timelock delay and the liveness response period.
    ///      Since this contract has no other extensions to coordinate with,
    ///      the hook is intentionally empty.
    function _checkCombinedConfig(Safe) internal view override {
        // no-op
    }
}
