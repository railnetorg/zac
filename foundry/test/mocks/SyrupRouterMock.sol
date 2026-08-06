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

    constructor(address pm) {
        $syrupPoolManager = pm;
        $baseAsset = SyrupPoolManager($syrupPoolManager).$pool().asset();
    }

    function deposit(uint256 assets, bytes32) public returns (bool) {
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

    function poolPermissionManager() public pure returns (address) {
        // The mock pool is unpermissioned; the real router points at Maple's PoolPermissionManager.
        return address(0);
    }
}
