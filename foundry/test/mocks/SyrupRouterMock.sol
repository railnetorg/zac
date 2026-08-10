// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMaplePool} from "src/interfaces/IMaplePool.sol";

import {SyrupPoolManager} from "./SyrupPoolManager.sol";

/// @title  SyrupRouterMock
/// @notice Maple's `SyrupRouter` simplified for testing: pulls the caller's assets and deposits them into the
///         pool, crediting the caller with the shares.
/// @dev    The public Syrup pools are permissioned at function level, so the router is the only deposit path.
///         Shares are credited to `msg.sender`, which is the Safe -- the manager relies on that to measure the
///         Safe's share delta.
contract SyrupRouterMock {
    using SafeERC20 for ERC20;

    address public $syrupPoolManager;
    address public $baseAsset;

    error Err(string message);

    constructor(address pm) {
        $syrupPoolManager = pm;
        $baseAsset = SyrupPoolManager($syrupPoolManager).$pool().asset();
    }

    /// @dev Enforces `P:deposit` exactly as the real router does, so an un-allowlisted Safe reverts
    ///      `SR:D:NOT_AUTHORIZED` rather than silently succeeding.
    function deposit(uint256 assets, bytes32) public returns (bool) {
        if (!SyrupPoolManager($syrupPoolManager).hasDepositPermission(msg.sender)) {
            revert Err("SR:D:NOT_AUTHORIZED");
        }
        address _pool = address(SyrupPoolManager($syrupPoolManager).$pool());
        ERC20($baseAsset).safeTransferFrom(msg.sender, address(this), assets);
        ERC20($baseAsset).forceApprove(_pool, assets);
        IMaplePool(_pool).deposit(assets, msg.sender);
        return true;
    }

    function pool() public view returns (address) {
        return address(SyrupPoolManager($syrupPoolManager).$pool());
    }

    function asset() public view returns (address) {
        return $baseAsset;
    }

    function poolManager() public view returns (address) {
        return $syrupPoolManager;
    }

    /// @notice Maple's permission manager, as the real router exposes it.
    /// @dev Read straight off the pool manager so a test configures permissioning in one place. `address(0)`
    ///      means the mock pool is open, which is the default.
    function poolPermissionManager() public view returns (address) {
        return SyrupPoolManager($syrupPoolManager).poolPermissionManager();
    }
}
