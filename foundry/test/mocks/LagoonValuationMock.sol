// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ILagoonValuation} from "src/interfaces/ILagoonValuation.sol";

/// @title  LagoonValuationMock
/// @notice The Lagoon vault's valuation surface.
/// @dev    Records proposals so a test can assert what the manager pushed, and can simulate the vault rejecting
///         one -- which is how Lagoon's price-per-share guardrails present to a valuation manager.
///
///         Two rejection modes, because they answer different questions. {setRejectProposals} refuses
///         unconditionally, which is all a test needs to prove the manager does not record an unsettled push.
///         {setMaxMoveBps} refuses as a *function of the value*: a proposal further than that many basis points
///         from the last accepted one is rejected, which is what Lagoon's price-per-share guardrail actually
///         does. Only the second mode can express "this NAV move would trip the real guardrail, that one would
///         not" -- the property the escrow and manual terms exist to protect.
contract LagoonValuationMock is ILagoonValuation {
    /// @dev Basis-points denominator.
    uint256 internal constant BPS_MAX = 10_000;

    /// @dev Sentinel for "no price-per-share bound at all".
    uint256 internal constant NO_LIMIT = type(uint256).max;

    address public vaultAsset;
    address public vaultSafe;
    bool public totalAssetsValid = true;
    bool public rejectProposals;

    /// @notice The largest relative move a proposal may make against the last accepted one, in basis points.
    /// @dev Defaults to unbounded so a test has to opt into the guardrail, leaving every existing scenario
    ///      unchanged.
    uint256 public maxMoveBps = NO_LIMIT;

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

    /// @dev Stands in for `GuardRailsManager` refusing every proposal, whatever its value.
    function setRejectProposals(bool reject_) external {
        rejectProposals = reject_;
    }

    /// @dev Stands in for `GuardRailsManager` refusing an abnormal price-per-share move: anything further than
    ///      `maxMoveBps_` from the last accepted proposal. `type(uint256).max` restores the unbounded default.
    function setMaxMoveBps(uint256 maxMoveBps_) external {
        maxMoveBps = maxMoveBps_;
    }

    function setSafe(address safe_) external {
        vaultSafe = safe_;
    }

    /// @notice Whether the guardrail would accept `candidate` as the next proposal.
    /// @dev Exposed so a test can price a hypothetical NAV -- for instance the one a three-term valuation would
    ///      have produced -- without proposing it.
    function wouldAccept(uint256 candidate_) public view returns (bool accepted_) {
        if (rejectProposals) return false;
        uint256 anchor_ = newTotalAssets;
        if (maxMoveBps == NO_LIMIT || proposalCount == 0 || anchor_ == 0) return true;
        uint256 delta_ = candidate_ > anchor_ ? candidate_ - anchor_ : anchor_ - candidate_;
        return delta_ * BPS_MAX <= anchor_ * maxMoveBps;
    }

    /// @inheritdoc ILagoonValuation
    function updateNewTotalAssets(uint256 newTotalAssets_) external override {
        if (!wouldAccept(newTotalAssets_)) revert GuardRailRejected(newTotalAssets_);
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
