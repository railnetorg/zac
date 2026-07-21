// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MilkmanSwapManager, IMilkman} from "src/MilkmanSwapManager.sol";

/// @notice Minimal Chainlink AggregatorV3 surface (the "Calculated" Ondo GM feeds + base/USD implement this).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice The Lagoon vault surface a valuationManager needs. `asset()` is immutable (ERC-4626);
///         `safe()` is mutable (owner can `updateSafe`) so it is checked live against the pinned SAFE.
interface ILagoonVault {
    function updateNewTotalAssets(uint256 newTotalAssets) external; // onlyValuationManager
    function asset() external view returns (address);
    function safe() external view returns (address);
}

/// @title  RwaVaultManager
/// @notice The single, all-in-one contract for an automated single-RWA Lagoon vault (RAIL-27). It IS
///         both the CoW/Milkman swap manager (from `MilkmanSwapManager`, RAIL-26) AND the vault's
///         on-chain Lagoon `valuationManager`. A risk-minimized keeper drives both, and NAV is
///         computed 100% on-chain from the Safe's balances.
/// @dev    Valuation reuses the RAIL-24 NavSettler pricing (idle base at face + Σ token holdings
///         priced via Chainlink and converted to base units, per-feed staleness, base-stablecoin
///         depeg absorbed through the base/USD feed).
///
///         BASE ASSET IS PARAMETERIZED — NOT USDC-SPECIFIC. The base asset is read from
///         `VAULT.asset()` and its /USD feed is the `baseUsdFeed` constructor arg, with all decimals
///         derived at construction (`BASE_SCALE`, `BASE_USD_UNIT`). So a vault denominated in ANY
///         USD stablecoin that has a Chainlink /USD feed is supported — USDC, USDT, DAI, PYUSD, … —
///         not just USDC (the USDC mentions elsewhere are only the Ondo-GM example). A non-USD base
///         (e.g. WETH) is out of scope: it would need a different feed topology.
///
///         KEY INVARIANT — NAV IS ONLY TAKEN AT REST. `pushNav` refuses while a CoW order is live
///         (`isPending()`, the donation-safe quiescence gate from RAIL-26). So NAV is never computed
///         while sold assets sit in a Milkman clone (invisible to a Safe-balance read) — there is no
///         in-flight accounting, and a keeper cannot push a NAV mid-trade. The trading half's trust
///         boundary (invariant 6 of `MilkmanSwapManager`) is unchanged: fund safety still depends on
///         the RAIL-28 Roles policy; this contract only makes NAV trustless.
///
///         SAFE is pinned (inherited immutable). `pushNav` additionally asserts `SAFE == VAULT.safe()`
///         so that, if the vault's Safe is moved via `updateSafe`, valuation fails closed (redeploy +
///         re-point the valuationManager) rather than pricing the wrong account.
///
///         FEED FRESHNESS (operational). NAV freshness is bounded by each feed's `maxAge`; the keeper
///         chooses the snapshot instant within that window (it cannot choose the value). Set each
///         `maxAge` to the feed's REAL heartbeat plus a small margin — not a blanket long value — and
///         pair it with a tight Lagoon `totalAssetsLifespan` so a snapshot can't be settled long after
///         it was taken. (The fork test's 7-day `maxAge` is for fork robustness, not a production
///         value.) Whether RWA weekend/holiday staleness should *block* settlement rather than be
///         tolerated is a keeper/guardrails concern (RAIL-19 / RAIL-21), as is the push->settle
///         sequencing (quiescence is enforced at `pushNav`, not at the Safe's later `settle*`).
contract RwaVaultManager is MilkmanSwapManager {
    /// @param token  Priced holding (e.g. an Ondo GM token).
    /// @param feed   Chainlink USD feed for `token`.
    /// @param maxAge Max seconds `feed.updatedAt` may lag now before pricing reverts.
    struct HoldingConfig {
        address token;
        address feed;
        uint256 maxAge;
    }

    struct Holding {
        IERC20 token;
        IAggregatorV3 feed;
        uint256 tokenUnit; // 10 ** token.decimals()
        uint256 feedUnit; //  10 ** feed.decimals()
        uint256 maxAge;
    }

    error NoHoldings();
    error NonPositivePrice(address feed, int256 answer);
    error StalePrice(address feed, uint256 updatedAt, uint256 age);
    error BaseAssetHolding(address token);
    error DuplicateHolding(address token);
    error OrderInFlight(); // pushNav attempted while a CoW order is live (not quiescent)
    error SafeMoved(); // VAULT.safe() no longer equals the pinned SAFE

    event NavPushed(uint256 nav);

    ILagoonVault public immutable VAULT;
    IERC20 public immutable BASE_ASSET; // = VAULT.asset()
    uint256 public immutable BASE_SCALE; // 10 ** BASE_ASSET.decimals()
    IAggregatorV3 public immutable BASE_USD_FEED; // base-asset/USD — converts USD-priced holdings into base units
    uint256 public immutable BASE_USD_UNIT; // 10 ** BASE_USD_FEED.decimals()
    uint256 public immutable BASE_USD_MAX_AGE;

    Holding[] private _holdings;

    /// @param vault         Lagoon vault (this contract becomes its valuationManager). `asset()`+`safe()` are read from it.
    /// @param keeper        Address allowed to drive the lifecycle (openSwap / cancelSwap / pushNav).
    /// @param milkman       The deployed root Milkman.
    /// @param baseUsdFeed   Chainlink feed for base-asset/USD (e.g. USDC/USD).
    /// @param baseUsdMaxAge Max staleness for `baseUsdFeed`.
    /// @param holdings      Priced holdings (token, USD feed, per-feed maxAge).
    constructor(
        address vault,
        address keeper,
        IMilkman milkman,
        address baseUsdFeed,
        uint256 baseUsdMaxAge,
        HoldingConfig[] memory holdings
    ) MilkmanSwapManager(milkman, ILagoonVault(vault).safe(), keeper) {
        if (holdings.length == 0) revert NoHoldings();
        if (baseUsdFeed == address(0)) revert ZeroAddress();

        VAULT = ILagoonVault(vault);
        address base = ILagoonVault(vault).asset();
        BASE_ASSET = IERC20(base);
        BASE_SCALE = 10 ** IERC20Metadata(base).decimals();
        BASE_USD_FEED = IAggregatorV3(baseUsdFeed);
        BASE_USD_UNIT = 10 ** IAggregatorV3(baseUsdFeed).decimals();
        BASE_USD_MAX_AGE = baseUsdMaxAge;

        for (uint256 i; i < holdings.length; ++i) {
            address token = holdings[i].token;
            if (token == address(0) || holdings[i].feed == address(0)) revert ZeroAddress();
            // A base-asset holding double-counts (idle base is already at face); a duplicate counts twice.
            // Both are silent immutable mispricings, so reject them at deploy. O(n^2) is fine for a few holdings.
            if (token == base) revert BaseAssetHolding(token);
            for (uint256 j; j < i; ++j) {
                if (holdings[j].token == token) revert DuplicateHolding(token);
            }
            _holdings.push(
                Holding({
                    token: IERC20(token),
                    feed: IAggregatorV3(holdings[i].feed),
                    tokenUnit: 10 ** IERC20Metadata(token).decimals(),
                    feedUnit: 10 ** IAggregatorV3(holdings[i].feed).decimals(),
                    maxAge: holdings[i].maxAge
                })
            );
        }
    }

    /// @notice Number of priced holdings.
    function holdingCount() external view returns (uint256) {
        return _holdings.length;
    }

    /// @notice The i-th priced holding (resolved config).
    function holdingAt(uint256 i) external view returns (Holding memory) {
        return _holdings[i];
    }

    /// @notice NAV in base-asset units: idle base at face + Σ (token holdings priced in USD, converted to base).
    /// @dev    Prices the pinned `SAFE`. Reverts if any priced holding with a non-zero balance — or the
    ///         base/USD feed, once any such holding is seen — is non-positive or older than its `maxAge`.
    ///         A base-only vault reads no feed at all. Does NOT gate on quiescence — call `pushNav` for
    ///         the gated path; a bare `previewNav` read mid-order would omit the in-flight escrow.
    function previewNav() public view returns (uint256 nav) {
        nav = BASE_ASSET.balanceOf(SAFE); // idle base asset, at face

        uint256 basePrice; // base/USD; fetched lazily on the first non-zero USD-priced holding
        uint256 len = _holdings.length;
        for (uint256 i; i < len; ++i) {
            Holding storage h = _holdings[i];
            uint256 bal = h.token.balanceOf(SAFE);
            if (bal == 0) continue;

            // _price reverts on a non-positive answer, so a fetched basePrice is always > 0 — safe as the "unset" sentinel.
            if (basePrice == 0) basePrice = _price(BASE_USD_FEED, BASE_USD_MAX_AGE);

            uint256 tokenPrice = _price(h.feed, h.maxAge); // token/USD
            uint256 usd = Math.mulDiv(bal, tokenPrice * BASE_SCALE, h.tokenUnit);
            nav += Math.mulDiv(usd, BASE_USD_UNIT, h.feedUnit * basePrice);
        }
    }

    /// @notice Compute NAV and propose it to the vault. Keeper-only; requires quiescence and this
    ///         contract being the vault's valuationManager. The Safe still confirms via
    ///         `settleDeposit` / `settleRedeem`.
    /// @dev    Reverts if a CoW order is live (`OrderInFlight`) or the vault's Safe has moved
    ///         (`SafeMoved`) — both fail closed rather than posting a wrong value.
    function pushNav() external onlyKeeper nonReentrant returns (uint256 nav) {
        if (isPending()) revert OrderInFlight();
        if (VAULT.safe() != SAFE) revert SafeMoved();
        nav = previewNav();
        VAULT.updateNewTotalAssets(nav);
        emit NavPushed(nav);
    }

    function _price(IAggregatorV3 feed, uint256 maxAge) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert NonPositivePrice(address(feed), answer);
        // A feed whose updatedAt is in the future (clock skew) is treated as fresh (age 0); production
        // Chainlink feeds should never report a future timestamp.
        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        if (age > maxAge) revert StalePrice(address(feed), updatedAt, age);
        return uint256(answer);
    }
}
