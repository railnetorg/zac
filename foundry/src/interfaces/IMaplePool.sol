// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  IMaplePool
/// @notice The subset of Maple's ERC-4626-style pool ABI used by `SyrupNavManager` and its tests.
///
/// @dev    A deliberate subset, not the full pool interface. Signatures are copied verbatim from Maple's pool
///         (including the trailing-underscore parameter names) so selectors and ABI encoding match the deployed
///         contract exactly; only the declarations this integration actually calls are carried across.
///
///         Two members deserve attention when reading the manager:
///
///         - `convertToExitAssets` is the loss-aware conversion and the only one valuation may use. Plain
///           `convertToAssets` omits the pool's unrealized-loss haircut, so it would mark the position above
///           what a redeemer actually receives.
///         - `requestRedeem` escrows shares into the withdrawal manager rather than paying out, and
///           `removeShares` is the cancellation counterpart. Both move shares off the Safe's balance, which is
///           why the manager values escrowed shares as a separate NAV term.
interface IMaplePool {
    /// @notice The pool's underlying asset.
    function asset() external view returns (address asset_);

    /// @notice The pool manager, which owns the withdrawal manager reference.
    function manager() external view returns (address manager_);

    /// @notice The pool share balance of `account_`.
    function balanceOf(address account_) external view returns (uint256 balance_);

    /// @notice The pool share allowance `owner_` has granted `spender_`.
    function allowance(address owner_, address spender_) external view returns (uint256 allowance_);

    /// @notice The pool share decimals, which track the underlying asset's.
    function decimals() external view returns (uint8 decimals_);

    /// @notice The maximum assets `receiver_` may currently deposit. Zero for an un-allowlisted address.
    function maxDeposit(address receiver_) external view returns (uint256 assets_);

    /// @notice Deposits `assets_` and mints shares to `receiver_`.
    function deposit(uint256 assets_, address receiver_) external returns (uint256 shares_);

    /// @notice Burns escrowed shares and pays `receiver_`. Called by the withdrawal manager, not by lenders.
    function redeem(uint256 shares_, address receiver_, address owner_) external returns (uint256 assets_);

    /// @notice Escrows `shares_` of `owner_` into the withdrawal manager's FIFO queue.
    function requestRedeem(uint256 shares_, address owner_) external returns (uint256 escrowShares_);

    /// @notice Cancels queued shares, returning them to `owner_`.
    /// @dev Takes no request id: the withdrawal manager resolves the removal through `requestIds(owner_)`, so
    ///      only the owner's latest queue entry is reachable.
    function removeShares(uint256 shares_, address owner_) external returns (uint256 sharesReturned_);

    /// @notice Converts shares to assets, ignoring unrealized losses. Not for valuation.
    function convertToAssets(uint256 shares_) external view returns (uint256 assets_);

    /// @notice Converts shares to the assets an exit would actually yield, net of unrealized losses.
    function convertToExitAssets(uint256 shares_) external view returns (uint256 assets_);
}
