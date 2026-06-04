// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockGuardOnly} from "../src/guards/TimeLock.guard.sol";

/// @notice Deploys a singleton `TimelockGuardOnly` for any Safe v1.4.1 on the
///         target network to install. The contract has no constructor args.
///         The guard's actual configuration (per-Safe delay, etc.) is set
///         after the fact by each Safe via `configureTimelockGuard` — see
///         the ZAC `safe.yaml` `guard: { address, timelock_delay }` flow.
///
///         Run:
///           forge script script/DeployTimelockGuardOnly.s.sol \
///             --rpc-url $RPC_URL --broadcast --private-key $PK
contract DeployTimelockGuardOnly is Script {
    function run() external returns (TimelockGuardOnly guard) {
        vm.startBroadcast();
        guard = new TimelockGuardOnly();
        vm.stopBroadcast();

        console2.log("TimelockGuardOnly deployed at:", address(guard));
        console2.log("version:", guard.version());
    }
}
