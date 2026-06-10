// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ISafe} from "@safe/interfaces/ISafe.sol";
import {SAFE_SINGLETON_V1_4_1, SAFE_PROXY_FACTORY_V1_4_1} from "./chainConfigs/MainnetAddresses.sol";

/// Minimal subset of the Safe v1.4.1 ProxyFactory ABI used here.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

/// @title  SafeDeployer
/// @notice Inheritable helper that deploys a fresh single-owner Safe v1.4.1 via the mainnet
///         `SafeProxyFactory`. Inherit it from a fork test and call `createSafe()` — the
///         inheriting contract becomes the sole owner (threshold = 1), so it can sign txns via
///         the pre-validated-signature path (v=1).
abstract contract SafeDeployer {
    /// Deploy a fresh Safe with `address(this)` as the sole owner (threshold = 1).
    function createSafe() internal returns (ISafe) {
        return createSafe(address(this));
    }

    /// Deploy a fresh Safe with `owner` as the sole owner (threshold = 1).
    function createSafe(address owner) internal returns (ISafe) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory setupCalldata = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            uint256(1),
            address(0),
            "",
            address(0),
            address(0),
            uint256(0),
            address(0)
        );
        // `gasleft()` varies across invocations even within the same block, so this avoids
        // CREATE2 collisions on rapid same-block re-runs (e.g., invariant / fuzz loops).
        uint256 salt = uint256(keccak256(abi.encodePacked(block.timestamp, address(this), gasleft())));
        address proxy =
            ISafeProxyFactory(SAFE_PROXY_FACTORY_V1_4_1).createProxyWithNonce(SAFE_SINGLETON_V1_4_1, setupCalldata, salt);
        return ISafe(payable(proxy));
    }
}
