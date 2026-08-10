// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMaplePool} from "src/interfaces/IMaplePool.sol";

import {PoolPermissionManagerMock} from "./PoolPermissionManagerMock.sol";
import {SyrupWithdrawalManager} from "./SyrupWithdrawalManager.sol";

/// @title  SyrupPoolManager
/// @notice Maple's pool manager simplified for testing: owns the pool and withdrawal manager references and
///         brokers the queued-withdrawal handoff between them.
contract SyrupPoolManager {
    using SafeERC20 for IERC20;

    address public immutable $asset;
    IMaplePool public $pool;
    SyrupWithdrawalManager public $withdrawalManager;
    address public $poolPermissionManager;

    error Err(string message);

    constructor(address asset_) {
        $asset = asset_;
    }

    function setPoolPermissionManager(address poolPermissionManager_) external {
        $poolPermissionManager = poolPermissionManager_;
    }

    function poolPermissionManager() external view returns (address) {
        return $poolPermissionManager;
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

    /// @notice Points the manager at a pool.
    /// @dev A setter rather than a `new SyrupPoolMock(...)` factory on purpose. Constructing a child here would
    ///      embed the child's entire initcode in this contract's bytecode, and with both the pool and the
    ///      withdrawal manager spawned that way this mock blew past the EIP-170 runtime limit and failed
    ///      `forge build --sizes`. The test deploys the children and wires them.
    function setPool(address pool_) external {
        $pool = IMaplePool(pool_);
    }

    /// @notice Points the manager at a withdrawal manager.
    /// @dev Also how a test reproduces a rotation: deploy a second manager and re-point. See {setPool} for why
    ///      this is a setter and not a factory.
    function setWithdrawalManager(address withdrawalManager_) external {
        $withdrawalManager = SyrupWithdrawalManager(withdrawalManager_);
    }

    /// @dev Routes a redeem. Two paths, matching Maple: the queue path burns the withdrawal manager's shares,
    ///      while the manual path consumes the owner's manual bucket -- whose pool tokens are also held by the
    ///      withdrawal manager, which is why the burn source is returned rather than assumed to be `owner_`.
    function processRedeem(uint256 shares_, address owner_, address sender_)
        external
        returns (uint256 redeemableShares_, uint256 resultingAssets_, address burnFrom_)
    {
        if ($withdrawalManager.isManualWithdrawal(owner_) && $withdrawalManager.lockedShares(owner_) >= shares_) {
            if (owner_ != sender_) revert Err("PM:PR:NOT_OWNER");
            (redeemableShares_, resultingAssets_) = $withdrawalManager.processManualExit(shares_, owner_);
            return (redeemableShares_, resultingAssets_, address($withdrawalManager));
        }

        if (owner_ != sender_) {
            if (IMaplePool($pool).allowance(owner_, sender_) == 0) {
                revert Err("NO_ALLOWANCE");
            }
        }

        (redeemableShares_, resultingAssets_) = $withdrawalManager.processExit(shares_, owner_);
        return (redeemableShares_, resultingAssets_, owner_);
    }

    /// @notice Whether `receiver_` may deposit, per the configured permission manager.
    /// @dev Mirrors `MaplePoolManager._getMaxAssets`'s permission term. With no permission manager configured
    ///      the mock pool is open, which is the default most tests want.
    function hasDepositPermission(address receiver_) public view returns (bool) {
        address ppm_ = $poolPermissionManager;
        if (ppm_ == address(0)) return true;
        return PoolPermissionManagerMock(ppm_).hasPermission(address(this), receiver_, bytes32("P:deposit"));
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
