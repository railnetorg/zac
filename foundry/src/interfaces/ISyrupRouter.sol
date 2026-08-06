// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  ISyrupRouter
/// @notice The subset of Maple's `SyrupRouter` ABI used by `SyrupNavManager` and its tests.
/// @dev    Deposits into a public Syrup pool must go through the router rather than the pool directly, because
///         the pools are permissioned at function level (`permissionLevel == 1` on Maple's
///         `PoolPermissionManager`). An address Maple has not allowlisted sees `maxDeposit == 0` and the router
///         reverts `SR:D:NOT_AUTHORIZED`.
///
///         Signatures are copied verbatim from the deployed router; the permit and authorize variants are
///         omitted because this integration allowlists the Safe out of band and never signs on its behalf.
interface ISyrupRouter {
    /// @notice Optional deposit data for off-chain processing.
    /// @param owner The receiver of the shares.
    /// @param amount The amount of assets deposited.
    /// @param depositData The attribution tag.
    event DepositData(address indexed owner, uint256 amount, bytes32 depositData);

    /// @notice Mints shares to the caller by depositing `assets` into the pool.
    /// @dev Mints at the pool's exchange rate, so there is no slippage on the way in.
    /// @param assets The amount of assets to deposit.
    /// @param depositData Maple's attribution tag, conventionally `0:<integrator-name>`.
    /// @return shares The amount of shares minted.
    function deposit(uint256 assets, bytes32 depositData) external returns (uint256 shares);

    /// @notice The underlying asset the router accepts.
    function asset() external view returns (address asset);

    /// @notice The pool the router deposits into.
    function pool() external view returns (address pool);

    /// @notice The pool's manager.
    function poolManager() external view returns (address poolManager);

    /// @notice Maple's permission manager, where the depositing address must be allowlisted before go-live.
    function poolPermissionManager() external view returns (address poolPermissionManager);
}
