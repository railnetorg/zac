// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ILagoonValuation} from "src/interfaces/ILagoonValuation.sol";

/// @title  LagoonValuationMock
/// @notice The Lagoon vault's valuation surface.
/// @dev    Records proposals so a test can assert what the manager pushed, and can simulate the vault rejecting
///         one -- which is how Lagoon's price-per-share guardrails present to a valuation manager.
contract LagoonValuationMock is ILagoonValuation {
    address public vaultAsset;
    address public vaultSafe;
    bool public totalAssetsValid = true;
    bool public rejectProposals;

    uint256 public newTotalAssets;
    uint256 public proposalCount;

    error GuardRailRejected(uint256 newTotalAssets);

    constructor(address asset_, address safe_) {
        vaultAsset = asset_;
        vaultSafe = safe_;
    }

    function setTotalAssetsValid(bool valid_) external {
        totalAssetsValid = valid_;
    }

    /// @dev Stands in for `GuardRailsManager` refusing an abnormal price-per-share move.
    function setRejectProposals(bool reject_) external {
        rejectProposals = reject_;
    }

    function setSafe(address safe_) external {
        vaultSafe = safe_;
    }

    /// @inheritdoc ILagoonValuation
    function updateNewTotalAssets(uint256 newTotalAssets_) external override {
        if (rejectProposals) revert GuardRailRejected(newTotalAssets_);
        newTotalAssets = newTotalAssets_;
        ++proposalCount;
    }

    /// @inheritdoc ILagoonValuation
    function isTotalAssetsValid() external view override returns (bool) {
        return totalAssetsValid;
    }

    /// @inheritdoc ILagoonValuation
    function asset() external view override returns (address) {
        return vaultAsset;
    }

    /// @inheritdoc ILagoonValuation
    function safe() external view override returns (address) {
        return vaultSafe;
    }
}
