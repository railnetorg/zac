// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  PoolPermissionManagerMock
/// @notice Maple's `MaplePoolPermissionManager` reduced to the one question the integration asks it.
/// @dev    Reproduces FUNCTION_LEVEL (`permissionLevel == 1`) resolution, which is what syrupUSDC runs:
///
///         1. a lender on `lenderAllowlist[poolManager]` is allowed, whatever the bitmaps say;
///         2. otherwise the pool's per-function bitmap must be a subset of the lender's bitmap.
///
///         The second rule is why a zero pool bitmap makes a function permissionless for everyone -- the state
///         `P:requestRedeem` and `P:redeem` are actually in on mainnet, while `P:deposit` and `P:removeShares`
///         both require bit 4. Tests can reproduce either.
contract PoolPermissionManagerMock {
    /// @notice Per-pool permission level. 0 PRIVATE, 1 FUNCTION_LEVEL, 2 POOL_LEVEL, 3 PUBLIC.
    mapping(address => uint256) public permissionLevels;

    /// @notice Lenders allowlisted per pool manager. Short-circuits before any bitmap is read.
    mapping(address => mapping(address => bool)) public lenderAllowlist;

    /// @notice The bitmap a pool requires for a given function id.
    mapping(address => mapping(bytes32 => uint256)) public poolBitmaps;

    /// @notice A lender's global bitmap, shared across every pool.
    mapping(address => uint256) public lenderBitmaps;

    function setPermissionLevel(address poolManager_, uint256 level_) external {
        permissionLevels[poolManager_] = level_;
    }

    function setLenderAllowlist(address poolManager_, address lender_, bool allowed_) external {
        lenderAllowlist[poolManager_][lender_] = allowed_;
    }

    function setPoolBitmap(address poolManager_, bytes32 functionId_, uint256 bitmap_) external {
        poolBitmaps[poolManager_][functionId_] = bitmap_;
    }

    function setLenderBitmap(address lender_, uint256 bitmap_) external {
        lenderBitmaps[lender_] = bitmap_;
    }

    /// @notice Whether `lender_` may call `functionId_` on `poolManager_`'s pool.
    function hasPermission(address poolManager_, address lender_, bytes32 functionId_)
        external
        view
        returns (bool allowed_)
    {
        uint256 level_ = permissionLevels[poolManager_];
        if (level_ == 3) return true;
        if (lenderAllowlist[poolManager_][lender_]) return true;
        if (level_ == 0) return false;
        if (level_ == 2) functionId_ = bytes32(0);
        uint256 poolBitmap_ = poolBitmaps[poolManager_][functionId_];
        return (poolBitmap_ & lenderBitmaps[lender_]) == poolBitmap_;
    }
}
