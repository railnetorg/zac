// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMaplePool} from "src/interfaces/IMaplePool.sol";

import {SyrupPoolMock} from "./SyrupPoolMock.sol";
import {SyrupWithdrawalManager} from "./SyrupWithdrawalManager.sol";

/// @title  SyrupPoolManager
/// @notice Maple's pool manager simplified for testing: owns the pool and withdrawal manager references and
///         brokers the queued-withdrawal handoff between them.
contract SyrupPoolManager {
    using SafeERC20 for IERC20;

    address public immutable $asset;
    IMaplePool public $pool;
    SyrupWithdrawalManager public $withdrawalManager;

    error Err(string message);

    constructor(address asset_) {
        $asset = asset_;
    }

    function requestRedeem(uint256 shares_, address owner_, address sender_) external {
        IERC20(address($pool)).forceApprove(address($withdrawalManager), shares_);

        if (sender_ != owner_ && shares_ == 0) {
            if ($pool.allowance(owner_, sender_) == 0) {
                revert Err("PM:RR:NO_ALLOWANCE");
            }
        }

        SyrupWithdrawalManager($withdrawalManager).addShares(shares_, owner_);
    }

    /// @dev Maple only lets the owner cancel their own queued request.
    function removeShares(uint256 shares_, address owner_, address sender_) external returns (uint256) {
        if (sender_ != owner_) revert Err("PM:RS:NOT_OWNER");
        return SyrupWithdrawalManager($withdrawalManager).removeShares(shares_, owner_);
    }

    function spawnWithdrawalManager() external returns (SyrupWithdrawalManager) {
        SyrupWithdrawalManager swm = new SyrupWithdrawalManager(address($pool), address(this));
        $withdrawalManager = swm;
        return swm;
    }

    function spawnPool() external returns (SyrupPoolMock) {
        SyrupPoolMock p = new SyrupPoolMock($asset);
        $pool = IMaplePool(address(p));
        return p;
    }

    function processRedeem(uint256 shares_, address owner_, address sender_)
        external
        view
        returns (uint256 redeemableShares_, uint256 resultingAssets_)
    {
        if (owner_ != sender_) {
            if (IMaplePool($pool).allowance(owner_, sender_) == 0) {
                revert Err("NO_ALLOWANCE");
            }
        }

        (redeemableShares_, resultingAssets_) = SyrupWithdrawalManager($withdrawalManager).processExit(shares_, owner_);
    }

    function totalAssets() external view returns (uint256 totalAssets_) {
        totalAssets_ = ERC20($pool.asset()).balanceOf(address($pool));
        // No strategies in the mock so we assume all assets are in the pool.
    }

    function withdrawalManager() external view returns (SyrupWithdrawalManager) {
        return $withdrawalManager;
    }

    function totalSupply() external view returns (uint256) {
        // In this mock, we assume the total supply is the balance of the pool.
        return $pool.balanceOf(address(this));
    }

    function unrealizedLosses() external pure returns (uint256) {
        // In this mock, we assume there are no unrealized losses.
        return 0;
    }
}
