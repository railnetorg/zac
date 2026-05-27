// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  IFlashLoanHelper
/// @notice Stateless singleton orchestrating same-asset leveraged loops on Aave V3.
/// @dev    Invoked via DELEGATECALL by a Safe under a Zodiac Roles Modifier policy.
///         Every loop parameter is validated by Roles per call before reaching this contract.
interface IFlashLoanHelper {
    enum LoopDirection {
        Boost,
        Repay
    }

    /// @notice Which flash-loan protocol's API to call. Roles policy pins this consistently
    ///         with `flashVenue` (e.g., `flashVenueKind = Aave` requires `flashVenue = Aave Pool`).
    enum FlashVenueKind {
        Aave,
        Morpho
    }

    /// @notice Per-call configuration. Same-asset semantics: collateral and debt are the same token.
    /// @param  direction       Boost = leverage up, Repay = deleverage.
    /// @param  lendingVenue    Aave V3 Pool. Roles policy pins this to the Aave Pool address.
    /// @param  asset           ERC-20 used as both collateral and debt.
    /// @param  flashAmount     Flash-loan principal.
    /// @param  flashVenue      Aave V3 Pool or Morpho Blue singleton. Roles policy whitelists.
    /// @param  flashVenueKind  Which flash-loan API to use; Roles pins consistently with flashVenue.
    /// @param  minHealthFactor Post-loop HF floor (1e18 base). Roles enforces a per-vehicle minimum.
    struct LoopParams {
        LoopDirection direction;
        address lendingVenue;
        address asset;
        uint256 flashAmount;
        address flashVenue;
        FlashVenueKind flashVenueKind;
        uint256 minHealthFactor;
    }

    /// @notice Orchestrates a same-asset loop transaction. Must be entered via DELEGATECALL
    ///         from a Safe whose fallback handler is unset and which does not already have
    ///         this Helper enabled as a Module; reverts otherwise.
    function executeLoop(LoopParams calldata p) external;

    /// @notice Morpho Blue flash-loan callback. Invoked by Safe.fallback (CALL) when Morpho calls
    ///         back into the Safe; runs in Helper's storage context.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;

    /// @notice Aave V3 flash-loan callback. Routed identically to onMorphoFlashLoan.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}
