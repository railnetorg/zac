// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Minimal Chainlink AggregatorV3 surface (the "Calculated" Ondo GM feeds + USDC/USD implement this).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice The Lagoon vault surface a valuationManager needs. `asset()` is immutable (ERC-4626, safe to cache);
///         `safe()` is mutable (owner can `updateSafe`) so it is read live.
interface ILagoonVault {
    function updateNewTotalAssets(uint256 newTotalAssets) external; // onlyValuationManager
    function asset() external view returns (address);
    function safe() external view returns (address);
}

/// @title  NavSettler
/// @notice Immutable on-chain valuationManager for a Lagoon vault. Prices the vault's base asset (idle balance,
///         at face) plus a fixed set of Chainlink-priced tokens (e.g. Ondo GM) held by the vault's Safe, and
///         pushes the NAV to the vault via `updateNewTotalAssets`. PoC for M4.1 (EVM-2676); the reusable/pluggable
///         version is EVM-2671.
/// @dev    Design:
///         - One NavSettler per vault; no setters — to change anything, deploy a new one and re-point the vault's
///           valuationManager role at it.
///         - Deduced from the vault (not config): `BASE_ASSET`/`BASE_SCALE` from `asset()` (immutable, cached) and
///           the holder from `safe()` (mutable, read LIVE each call).
///         - NAV is denominated in the base asset (what `settleDeposit`/`settleRedeem` expect). Chainlink feeds
///           quote in USD, so USD-priced holdings are converted to the base via the base asset's own /USD feed
///           (`BASE_USD_FEED`), which also absorbs a base-stablecoin depeg; idle base asset is counted at face.
///         - The base asset is assumed USD-denominated with a Chainlink /USD feed — works for any USD stablecoin
///           (USDC, PYUSD, USDT, DAI); a non-USD base (e.g. WETH) would need a different feed topology.
///         - Per-feed staleness (`maxAge`). A NAV-delta cap / pause is the guardrails module's job (EVM-2674).
contract NavSettler {
    /// @param token    Priced holding (e.g. a GM token).
    /// @param feed     Chainlink USD feed for `token` (the GM "Calculated" feed).
    /// @param maxAge   Max seconds `feed.updatedAt` may lag now before pricing reverts.
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
    error NotKeeper();
    error NonPositivePrice(address feed, int256 answer);
    error StalePrice(address feed, uint256 updatedAt, uint256 age);
    error ZeroAddress();
    error BaseAssetHolding(address token);
    error DuplicateHolding(address token);

    event NavPushed(uint256 nav);

    ILagoonVault public immutable VAULT;
    IERC20 public immutable BASE_ASSET; // = VAULT.asset()
    uint256 public immutable BASE_SCALE; // 10 ** BASE_ASSET.decimals()
    IAggregatorV3 public immutable BASE_USD_FEED; // base-asset/USD (e.g. USDC/USD, PYUSD/USD) — converts USD-priced holdings into base units
    uint256 public immutable BASE_USD_UNIT; // 10 ** BASE_USD_FEED.decimals()
    uint256 public immutable BASE_USD_MAX_AGE;
    address public immutable KEEPER;

    Holding[] private _holdings;

    modifier onlyKeeper() {
        if (msg.sender != KEEPER) revert NotKeeper();
        _;
    }

    /// @param vault         Lagoon vault (this contract becomes its valuationManager). `asset()`+`safe()` are read from it.
    /// @param keeper        Address allowed to call `pushNav`.
    /// @param baseUsdFeed   Chainlink feed for base-asset/USD (e.g. USDC/USD), used to convert USD prices into base units.
    /// @param baseUsdMaxAge Max staleness for `baseUsdFeed`.
    /// @param holdings      Priced holdings (token, USD feed, per-feed maxAge).
    constructor(
        address vault,
        address keeper,
        address baseUsdFeed,
        uint256 baseUsdMaxAge,
        HoldingConfig[] memory holdings
    ) {
        if (holdings.length == 0) revert NoHoldings();
        if (vault == address(0) || keeper == address(0)) revert ZeroAddress();

        VAULT = ILagoonVault(vault);
        address base = ILagoonVault(vault).asset();
        BASE_ASSET = IERC20(base);
        BASE_SCALE = 10 ** IERC20Metadata(base).decimals();
        BASE_USD_FEED = IAggregatorV3(baseUsdFeed);
        BASE_USD_UNIT = 10 ** IAggregatorV3(baseUsdFeed).decimals();
        BASE_USD_MAX_AGE = baseUsdMaxAge;
        KEEPER = keeper;

        for (uint256 i; i < holdings.length; ++i) {
            address token = holdings[i].token;
            // A base-asset holding double-counts (idle base is already valued at face); a duplicate counts twice.
            // Both are silent, immutable mispricings, so reject them at deploy. O(n^2) is fine for a few holdings.
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

    /// @notice The vault's current Safe (read live — `updateSafe` may move it).
    function holder() public view returns (address) {
        return VAULT.safe();
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
    /// @dev Reverts if any priced holding with a non-zero balance — or the base/USD feed, once any such holding is
    ///      seen — is non-positive or older than its `maxAge`. A base-only vault reads no feed at all.
    function previewNav() public view returns (uint256 nav) {
        address safe = VAULT.safe();
        nav = BASE_ASSET.balanceOf(safe); // idle base asset, at face

        uint256 basePrice; // base/USD (e.g. USDC/USD); fetched lazily on the first non-zero USD-priced holding
        uint256 len = _holdings.length;
        for (uint256 i; i < len; ++i) {
            Holding storage h = _holdings[i];
            uint256 bal = h.token.balanceOf(safe);
            if (bal == 0) continue;

            // _price reverts on a non-positive answer, so a fetched basePrice is always > 0 — safe as the "unset" sentinel.
            if (basePrice == 0) basePrice = _price(BASE_USD_FEED, BASE_USD_MAX_AGE);

            uint256 tokenPrice = _price(h.feed, h.maxAge); // token/USD
            // usd = bal * tokenPrice * BASE_SCALE / tokenUnit  (still scaled by the token feed's decimals)
            uint256 usd = Math.mulDiv(bal, tokenPrice * BASE_SCALE, h.tokenUnit);
            // convert USD -> base units: / tokenFeedUnit, / basePrice, * baseFeedUnit
            nav += Math.mulDiv(usd, BASE_USD_UNIT, h.feedUnit * basePrice);
        }
    }

    /// @notice Compute NAV and propose it to the vault. Callable only by `KEEPER`; requires this contract to be
    ///         the vault's valuationManager. The Safe still confirms via `settleDeposit`/`settleRedeem`.
    function pushNav() external onlyKeeper returns (uint256 nav) {
        nav = previewNav();
        VAULT.updateNewTotalAssets(nav);
        emit NavPushed(nav);
    }

    function _price(IAggregatorV3 feed, uint256 maxAge) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert NonPositivePrice(address(feed), answer);
        // A feed whose updatedAt is in the future (clock skew / misbehaving feed) is treated as fresh (age 0);
        // production Chainlink feeds should never report a future timestamp.
        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        if (age > maxAge) revert StalePrice(address(feed), updatedAt, age);
        return uint256(answer);
    }
}
