// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {SyrupPoolManager} from "./SyrupPoolManager.sol";

/// @title  SyrupPoolMock
/// @notice A Maple pool simplified for testing: yield accrual, an unrealized-loss haircut, a deposit cap, and
///         the queued-withdrawal handoff to the pool manager.
/// @dev    Yield accrues continuously at `$yieldRate` (5% APY by default), which is what makes the NAV manager's
///         exchange-rate band meaningful in tests. `convertToExitAssets` applies the loss haircut and
///         `convertToAssets` does not -- the distinction the manager's valuation turns on.
contract SyrupPoolMock {
    using SafeERC20 for ERC20;

    ERC20 public $asset;
    mapping(address => uint256) public $shares;
    uint256 public $totalSupply;
    address public $manager;

    mapping(address => mapping(address => uint256)) public allowance;

    // Yield accrual variables
    uint256 public $totalAssets;
    int256 public $yieldRate; // Annual yield rate in basis points (e.g., 500 = 5%, -1000 = -10%)
    uint256 public $lastUpdateTimestamp;

    // Unrealized losses simulation
    uint256 public $unrealizedLosses;

    // Deposit cap simulation; unlimited unless a test lowers it.
    uint256 public $maxDeposit = type(uint256).max;

    error Err(string message);

    /// @param a The pool's underlying asset.
    /// @param manager_ The pool manager. Passed in rather than taken from `msg.sender` so the pool can be
    ///        deployed by a test and wired to the manager afterwards, which is what keeps the manager mock's
    ///        bytecode under the EIP-170 limit.
    constructor(address a, address manager_) {
        $asset = ERC20(a);
        $manager = manager_;
        $yieldRate = 500; // 5% annual yield by default
        $lastUpdateTimestamp = block.timestamp;
        $unrealizedLosses = 0; // No unrealized losses by default
    }

    /// @notice Set the annual yield rate in basis points (e.g., 500 = 5%, -1000 = -10%)
    function setYieldRate(int256 yieldRate) external {
        _updateYield();
        $yieldRate = yieldRate;
    }

    /// @notice Manually trigger yield update (useful for testing)
    function updateYield() external {
        _updateYield();
    }

    /// @notice Test helper: grows the pool's accounted assets without minting shares, lifting price-per-share.
    /// @dev The caller is responsible for backing the increase with real tokens so redemptions stay serviceable.
    function addAssets(uint256 amount) external {
        _updateYield();
        $totalAssets += amount;
    }

    /// @notice Set unrealized losses amount for testing purposes
    function setUnrealizedLosses(uint256 lossAmount) external {
        $unrealizedLosses = lossAmount;
    }

    /// @notice Set unrealized losses as a percentage of total assets (in basis points)
    /// @param lossBasisPoints Loss percentage in basis points (e.g., 100 = 1%, 1000 = 10%)
    function setUnrealizedLossesPercentage(uint256 lossBasisPoints) external {
        uint256 totalAssetsWithYield = _getTotalAssetsWithYield();
        $unrealizedLosses = Math.mulDiv(totalAssetsWithYield, lossBasisPoints, 10000, Math.Rounding.Ceil);
    }

    /// @notice Get current total assets including accrued yield
    function totalAssets() external view returns (uint256) {
        return _getTotalAssetsWithYield();
    }

    function deposit(uint256 amount, address to) public returns (uint256) {
        _updateYield();
        $asset.safeTransferFrom(msg.sender, address(this), amount);

        uint256 shares = convertToShares(amount);
        $shares[to] += shares;
        $totalSupply += shares;
        $totalAssets += amount;

        return shares;
    }

    function requestRedeem(uint256 shares, address owner) public returns (uint256) {
        _updateYield();
        // transfer shares from owner to pool manager
        $shares[owner] -= shares;
        $shares[$manager] += shares;

        SyrupPoolManager($manager).requestRedeem(shares, owner, msg.sender);

        return shares;
    }

    /// @dev Cancels a queued withdrawal. The withdrawal manager holds the escrowed shares and returns them
    ///      straight to the owner, so no share bookkeeping happens here.
    function removeShares(uint256 shares_, address owner_) public returns (uint256 sharesReturned_) {
        _updateYield();
        return SyrupPoolManager($manager).removeShares(shares_, owner_, msg.sender);
    }

    /// @dev Two burn sources, decided by the pool manager: the queue path burns the withdrawal manager's shares,
    ///      the manual path also burns the withdrawal manager's -- because a manually serviced request leaves
    ///      the pool tokens there, credited to the owner's bucket, rather than on the owner.
    function redeem(uint256 shares_, address receiver_, address owner_) public returns (uint256 assets_) {
        _updateYield();
        uint256 redeemableShares_;
        address burnFrom_;
        (redeemableShares_, assets_, burnFrom_) = SyrupPoolManager($manager).processRedeem(shares_, owner_, msg.sender);

        _burn(redeemableShares_, assets_, receiver_, burnFrom_, burnFrom_);
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        $shares[msg.sender] -= amount;
        $shares[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        if (allowance[from][msg.sender] < amount) {
            revert Err("Not enough allowance");
        }
        $shares[from] -= amount;
        $shares[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function balanceOf(address who) public view returns (uint256) {
        return $shares[who];
    }

    function totalSupply() public view returns (uint256) {
        return $totalSupply;
    }

    function balanceOfAssets(address who) public view returns (uint256) {
        return convertToAssets($shares[who]);
    }

    /// @dev `uint8` to match Maple's pool ABI, so the manager's `IERC20Metadata.decimals()` read is exact rather
    ///      than relying on a wider return happening to decode.
    function decimals() public view returns (uint8) {
        return $asset.decimals();
    }

    function asset() public view returns (address) {
        return address($asset);
    }

    function manager() public view returns (address) {
        return $manager;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 totalAssetsWithYield = _getTotalAssetsWithYield();
        if ($totalSupply == 0) {
            return assets;
        }
        return Math.mulDiv(assets, $totalSupply, totalAssetsWithYield, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        // Uses total assets with yield so accrual is reflected in the conversion.
        if ($totalSupply == 0) {
            return shares;
        }
        uint256 totalAssetsWithYield = _getTotalAssetsWithYield();
        return Math.mulDiv(shares, totalAssetsWithYield, $totalSupply, Math.Rounding.Floor);
    }

    /// @notice Returns the amount of exit assets for the input amount, accounting for unrealized losses.
    /// @param shares_ The amount of shares to convert to assets.
    /// @return assets_ Amount of assets able to be exited.
    function convertToExitAssets(uint256 shares_) public view returns (uint256 assets_) {
        uint256 baseAssets = convertToAssets(shares_);
        uint256 losses = unrealizedLosses();

        if ($totalSupply == 0) {
            return baseAssets;
        }

        // Apply proportional unrealized losses.
        uint256 totalAssetsWithYield = _getTotalAssetsWithYield();
        if (totalAssetsWithYield <= losses) {
            return 0;
        }

        // assets_ = baseAssets * (totalAssets - unrealizedLosses) / totalAssets
        return Math.mulDiv(baseAssets, totalAssetsWithYield - losses, totalAssetsWithYield, Math.Rounding.Floor);
    }

    /// @notice Returns the amount of unrealized losses.
    function unrealizedLosses() public view returns (uint256 unrealizedLosses_) {
        return $unrealizedLosses;
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    /// @notice Shares minted for a deposit of `assets`, rounding down.
    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets);
    }

    /// @notice Assets required to mint exactly `shares`, rounding up.
    function previewMint(uint256 shares) public view returns (uint256) {
        uint256 totalAssetsWithYield = _getTotalAssetsWithYield();
        if ($totalSupply == 0) {
            return shares;
        }
        return Math.mulDiv(shares, totalAssetsWithYield, $totalSupply, Math.Rounding.Ceil);
    }

    /// @notice Shares burned to exit exactly `assets`, accounting for unrealized losses, rounding up.
    function convertToExitShares(uint256 assets) public view returns (uint256) {
        uint256 totalAssetsWithYield = _getTotalAssetsWithYield();
        uint256 losses = unrealizedLosses();
        if ($totalSupply == 0 || totalAssetsWithYield <= losses) {
            return assets;
        }
        return Math.mulDiv(assets, $totalSupply, totalAssetsWithYield - losses, Math.Rounding.Ceil);
    }

    /// @notice Always 0, matching the live Maple pools.
    /// @dev Maple supports only queued `redeem`, never `withdraw`, so the real pools return 0 here. Returning a
    ///      "correct" value would let the mock hide any code path that leans on it.
    function previewWithdraw(uint256 assets) public pure returns (uint256) {
        assets;
        return 0;
    }

    function name() public pure returns (string memory) {
        return "Mock Syrup Pool";
    }

    function symbol() public pure returns (string memory) {
        return "MSP";
    }

    /// @notice The assets `receiver` may deposit: zero when Maple has not allowlisted them, zero when the pool
    ///         is at its cap, and never a revert -- the ambiguity the manager has to disambiguate.
    function maxDeposit(address receiver) public view returns (uint256) {
        if (!SyrupPoolManager($manager).hasDepositPermission(receiver)) {
            return 0;
        }
        return $maxDeposit;
    }

    /// @dev Lets a test simulate a pool at its deposit cap. Defaults to unlimited.
    function setMaxDeposit(uint256 maxDeposit_) public {
        $maxDeposit = maxDeposit_;
    }

    function _burn(uint256 shares_, uint256 assets_, address receiver_, address owner_, address caller_) internal {
        if (receiver_ == address(0)) revert Err("ZERO_RECEIVER");

        if (shares_ == 0) return;
        if (caller_ != owner_) {
            allowance[owner_][caller_] -= shares_;
        }

        $shares[owner_] -= shares_;
        $totalSupply -= shares_;
        $totalAssets -= assets_;

        $asset.safeTransfer(receiver_, assets_);
    }

    /// @notice Update yield based on time elapsed since last update
    function _updateYield() internal {
        if ($totalAssets == 0) return;

        uint256 timeElapsed = block.timestamp - $lastUpdateTimestamp;
        if (timeElapsed == 0) return;

        uint256 yieldMagnitude =
            Math.mulDiv($totalAssets, uint256(_abs($yieldRate)) * timeElapsed, 365 days * 10000, Math.Rounding.Floor);

        if ($yieldRate >= 0) {
            $totalAssets += yieldMagnitude;
        } else {
            // Prevent underflow - assets can't go below 0
            if (yieldMagnitude >= $totalAssets) {
                $totalAssets = 0;
            } else {
                $totalAssets -= yieldMagnitude;
            }
        }

        $lastUpdateTimestamp = block.timestamp;
    }

    /// @notice Get total assets including accrued yield (view function)
    function _getTotalAssetsWithYield() internal view returns (uint256) {
        if ($totalAssets == 0) return 0;

        uint256 timeElapsed = block.timestamp - $lastUpdateTimestamp;
        if (timeElapsed == 0) return $totalAssets;

        uint256 yieldMagnitude =
            Math.mulDiv($totalAssets, uint256(_abs($yieldRate)) * timeElapsed, 365 days * 10000, Math.Rounding.Floor);

        if ($yieldRate >= 0) {
            return $totalAssets + yieldMagnitude;
        } else {
            // Prevent underflow - assets can't go below 0
            if (yieldMagnitude >= $totalAssets) {
                return 0;
            } else {
                return $totalAssets - yieldMagnitude;
            }
        }
    }

    /// @notice Helper function to get absolute value of signed integer
    function _abs(int256 value) internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return value >= 0 ? uint256(value) : uint256(-value);
    }
}
