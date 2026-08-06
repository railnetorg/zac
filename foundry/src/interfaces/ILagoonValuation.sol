// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  ILagoonValuation
/// @notice The subset of the Lagoon v0.6.0 vault ABI `SyrupNavManager` consumes.
/// @dev    The manager is the vault's `valuationManager`, so it may only *propose* a value; the Safe confirms
///         it separately via `settleDeposit` / `settleRedeem`, which are deliberately NOT in this interface.
///         Keeping the settle functions out of reach is structural, not cosmetic: proposing and confirming
///         from one contract would collapse Lagoon's two-step valuation into a single point of failure.
interface ILagoonValuation {
    /// @notice Proposes a new total-assets value for the next settlement.
    /// @dev `onlyValuationManager` on the vault.
    /// @param newTotalAssets The proposed total assets, denominated in the vault's asset.
    function updateNewTotalAssets(uint256 newTotalAssets) external;

    /// @notice Whether the vault's cached `totalAssets` valuation is still within its lifespan.
    /// @return valid True while the cached valuation is fresh.
    function isTotalAssetsValid() external view returns (bool valid);

    /// @notice The vault's underlying asset.
    /// @return asset The asset address.
    function asset() external view returns (address asset);

    /// @notice The Safe that custodies the vault's deployed assets and acts as its curator.
    /// @dev Used only as a deployment-time cross-check that the manager values the same Safe the vault settles
    ///      through.
    /// @custom:security The getter name is Lagoon-version-dependent and must be confirmed against the deployed
    ///      vault; a mismatch surfaces as a constructor revert, not as silent misconfiguration.
    /// @return safe The Safe address.
    function safe() external view returns (address safe);
}
