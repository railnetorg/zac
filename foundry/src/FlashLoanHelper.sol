// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IFlashLoanHelper} from "./interfaces/IFlashLoanHelper.sol";
import {ISafe} from "@safe/interfaces/ISafe.sol";
import {Enum} from "@safe/interfaces/Enum.sol";
import {IPool} from "@aave-v3-origin/interfaces/IPool.sol";
import {IMorpho} from "@morpho-blue/interfaces/IMorpho.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  FlashLoanHelper
/// @notice Stateless singleton orchestrating same-asset leveraged loops on Aave V3. One deployment
///         per chain serves every vehicle on that chain; per-vehicle policy lives in each vault's
///         Roles Modifier configuration. Invoked via DELEGATECALL by the Safe — never directly.
///
/// @dev    SECURITY INVARIANTS:
///
///         (1) STATELESSNESS — zero storage variables. Audit-enforced; checked by
///             `forge inspect FlashLoanHelper storageLayout` returning empty.
///
///         (2) STORAGE DISCIPLINE — Helper code runs in the Safe's storage context. The only
///             Safe-side mutations performed are: `setFallbackHandler` at entry / exit,
///             `enableModule` / `disableModule` at entry / exit, and ERC-20 approvals / transfers
///             on the loop's asset. No writes to owners, threshold, modules linked-list outside
///             of the bracketed `enableModule`/`disableModule` calls.
///
///         (3) ATOMIC BRACKET on Module + fallback. `executeLoop` installs Helper as a Module
///             AND as fallback handler at entry; removes both at exit. Any revert between entry
///             and exit reverts the entire tx, atomically rolling both back. Outside an active
///             `executeLoop`, the Safe has neither.
///
///         (4) CALLBACK AUTHENTICATION — onMorphoFlashLoan / executeOperation run in Helper's
///             context. They verify `msg.sender` (the Safe) currently has Helper as fallback
///             handler (the mid-loop indicator), and that the appended-trailer original caller
///             equals the expected flash venue. Reverts otherwise.
///
///         (5) POST-LOOP HF CHECK — after the loop closes, the Helper reads the Safe's health
///             factor on Aave and reverts unless HF >= p.minHealthFactor.
///
///         (6) DUST CHECK — after the loop closes, the Safe's balance in p.asset equals the
///             expected post-loop position; no leakage or unexpected residuals.
///
///         (7) REENTRANCY — a nested call into `executeLoop` is impossible because: (a) Helper
///             is already enabled as a Module on the Safe — pre-check refuses entry, and
///             (b) the fallback handler is non-zero — same refusal.
///
///         (8) SAFE CRITICAL-STATE INVARIANCE — at the end of `executeLoop` the Safe's modules
///             list hash, threshold, owners-list hash, fallback handler, Guard, and Module Guard
///             all match the pre-loop snapshot. Any deviation reverts. Runtime guard against an
///             unforeseen bug or compromised Helper tampering with Safe configuration.
contract FlashLoanHelper is IFlashLoanHelper {
    /// @notice Sentinel address Safe uses as head/tail of its modules linked list.
    address private constant SENTINEL_MODULES = address(0x1);

    /// @notice Safe v1.4 fallback handler storage slot.
    /// @dev    keccak256("fallback_manager.handler.address"). Read via SLOAD under DELEGATECALL
    ///         (address(this) == Safe), written via Safe.setFallbackHandler.
    bytes32 private constant FALLBACK_HANDLER_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    /// @notice Safe v1.4 Guard storage slot.
    /// @dev    keccak256("guard_manager.guard.address"). Per-tx guard set via Safe.setGuard.
    ///         Not written by this Helper; snapshotted/validated as defense-in-depth — a
    ///         future Helper bug or unexpected callback path that managed to alter the Guard
    ///         would be caught by invariant 8.
    bytes32 private constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    /// @notice Safe v1.4 Module Guard storage slot.
    /// @dev    Per-module-call guard set via Safe.setModuleGuard. Same defense-in-depth
    ///         rationale as `GUARD_STORAGE_SLOT`.
    bytes32 private constant MODULE_GUARD_STORAGE_SLOT =
        0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    /// @notice Page size for `getModulesPaginated` when hashing the Safe's modules list. Safes
    ///         in this design have at most a handful of modules (Roles modifier + transient
    ///         Helper); 100 is comfortable headroom. The snapshot fails loudly if a Safe's
    ///         modules list exceeds this — see `TooManyModules`.
    uint256 private constant MODULES_PAGE_SIZE = 100;

    /// @notice Aave V3 interest-rate mode. Stable (1) is deprecated/disabled on most reserves;
    ///         we only ever use variable (2).
    uint256 private constant AAVE_VARIABLE_RATE = 2;

    // ---- Errors ----

    error MustDelegateCall();
    error FallbackHandlerAlreadySet(address current);
    error ModuleAlreadyEnabled(address module);
    error FallbackHandlerLeaked(address current);
    error ModuleLeaked(address module);
    error SafeStateTampered();
    error UnsupportedFlashVenueKind();
    error WrongCallbackForKind();
    error WrongHelper(address expected, address actual);
    error NotMidLoop(address safe);
    error WrongTrailer(address expected, address actual);
    error AmountMismatch(uint256 expected, uint256 actual);
    error AssetMismatch(address expected, address actual);
    error InitiatorMismatch(address expected, address actual);
    error InvalidDirection();
    error ExecTransactionFromModuleFailed();
    error HealthFactorTooLow(uint256 actual, uint256 floor);
    error DustResidual(uint256 expected, uint256 actual);
    error TooManyModules();
    error ZeroFlashAmount();

    /// @inheritdoc IFlashLoanHelper
    function executeLoop(LoopParams calldata p) external override {
        // ==== Pre-checks (invariant 7 — reentrancy guard) ====
        //
        // Reject a zero flashAmount — a degenerate loop that burns gas with no positional
        // change. Roles policy should also enforce `> 0` at the entry layer; this is
        // defence-in-depth.
        if (p.flashAmount == 0) revert ZeroFlashAmount();

        // Reject direct CALL on the Helper deployment. Under DELEGATECALL `address(this) == Safe`,
        // so `address(this) != p.helperAddress` (which is the canonical Helper, Roles-pinned).
        // `p.helperAddress` is also the identity reference we'll use for all install / uninstall
        // operations below — under DELEGATECALL the Helper cannot recover its own address
        // otherwise.
        if (address(this) == p.helperAddress) revert MustDelegateCall();

        ISafe safe = ISafe(payable(address(this)));

        // Outside an active executeLoop the Safe MUST have no fallback handler — a non-zero
        // handler here is either an in-flight loop (reentry) or a misconfigured Safe.
        address fallbackPre = _currentFallbackHandler();
        if (fallbackPre != address(0)) revert FallbackHandlerAlreadySet(fallbackPre);

        // Outside an active executeLoop the Helper MUST NOT already be a Module of this Safe.
        if (safe.isModuleEnabled(p.helperAddress)) revert ModuleAlreadyEnabled(p.helperAddress);

        // ==== Snapshot Safe critical state (invariant 8) ====

        uint256 thresholdPre = safe.getThreshold();
        bytes32 ownersHashPre = keccak256(abi.encode(safe.getOwners()));

        // Hash the modules list AND assert it fits in one page — if the Safe has more than
        // `MODULES_PAGE_SIZE` modules, only the first page would be hashed and tampering
        // beyond the page would go undetected. Better to fail loudly than silently miss it.
        (bytes32 modulesHashPre, address modulesNextPre) = _modulesPage(safe);
        if (modulesNextPre != SENTINEL_MODULES) revert TooManyModules();

        address guardPre = _sloadAddress(GUARD_STORAGE_SLOT);
        address moduleGuardPre = _sloadAddress(MODULE_GUARD_STORAGE_SLOT);
        uint256 assetBalancePre = IERC20(p.asset).balanceOf(address(this));
        // (fallback handler pre = address(0), verified above)

        // ==== Install transient state (invariant 3 — atomic bracket entry) ====
        //
        // Helper as Module gives the callback path the authority to call back into the Safe via
        // `execTransactionFromModule`. Helper as fallback handler routes Morpho / Aave flash-loan
        // callbacks (selectors unknown to Safe) into the Helper's callback functions.
        //
        // Both self-calls satisfy Safe's `authorized` modifier (`msg.sender == address(this)`)
        // because we are running in the Safe's frame under DELEGATECALL.
        safe.enableModule(p.helperAddress);
        safe.setFallbackHandler(p.helperAddress);

        // ==== Flash-loan dispatch ====
        //
        // Encode the full LoopParams into the callback payload. The callback decodes them and
        // executes supply / borrow / repay via `execTransactionFromModule` (since the callback
        // runs in Helper's context, not the Safe's).
        bytes memory payload = abi.encode(p);
        if (p.flashVenueKind == FlashVenueKind.Morpho) {
            IMorpho(p.flashVenue).flashLoan(p.asset, p.flashAmount, payload);
        } else if (p.flashVenueKind == FlashVenueKind.Aave) {
            IPool(p.flashVenue).flashLoanSimple(address(this), p.asset, p.flashAmount, payload, 0);
        } else {
            revert UnsupportedFlashVenueKind();
        }

        // ==== Uninstall transient state (invariant 3 — atomic bracket exit) ====

        safe.setFallbackHandler(address(0));
        safe.disableModule(SENTINEL_MODULES, p.helperAddress);

        // ==== Post-loop checks ====
        //
        // (Invariant 5 — post-loop HF check.) Read Safe's HF on the lending venue and reject
        // anything below the per-vehicle floor Roles enforced on `p.minHealthFactor`.
        //
        // NOTE: Aave V3-only. `getUserAccountData` is on Aave's IPool; Morpho Blue has no
        // equivalent (HF is per-market, oracle-priced via `position(id, user)`). Phase 1
        // pins `p.lendingVenue` to the Aave Pool via Roles, so this assumption holds. When
        // Phase 2 admits Morpho as a lending venue (EVM-2625), this check must branch on
        // the venue kind.
        (,,,,, uint256 healthFactorPost) = IPool(p.lendingVenue).getUserAccountData(address(this));
        if (healthFactorPost < p.minHealthFactor) {
            revert HealthFactorTooLow(healthFactorPost, p.minHealthFactor);
        }

        // (Invariant 6 — dust check.) The loop is net-balanced in `p.asset`: flash-borrow is
        // matched by supply/repay, and what we borrow-from / withdraw-from Aave is matched by
        // flash-repayment. Any residual means the loop didn't close cleanly.
        uint256 assetBalancePost = IERC20(p.asset).balanceOf(address(this));
        if (assetBalancePost != assetBalancePre) {
            revert DustResidual(assetBalancePre, assetBalancePost);
        }

        // ==== Validate critical state (invariant 8) ====
        //
        // Catch any execution path inside the bracket that altered Safe configuration.

        address fallbackPost = _currentFallbackHandler();
        if (fallbackPost != address(0)) revert FallbackHandlerLeaked(fallbackPost);
        if (safe.isModuleEnabled(p.helperAddress)) revert ModuleLeaked(p.helperAddress);
        if (safe.getThreshold() != thresholdPre) revert SafeStateTampered();
        if (keccak256(abi.encode(safe.getOwners())) != ownersHashPre) revert SafeStateTampered();
        (bytes32 modulesHashPost,) = _modulesPage(safe);
        if (modulesHashPost != modulesHashPre) revert SafeStateTampered();
        if (_sloadAddress(GUARD_STORAGE_SLOT) != guardPre) revert SafeStateTampered();
        if (_sloadAddress(MODULE_GUARD_STORAGE_SLOT) != moduleGuardPre) revert SafeStateTampered();
    }

    /// @inheritdoc IFlashLoanHelper
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        LoopParams memory p = abi.decode(data, (LoopParams));

        // (Invariant 4 — callback authentication.)
        if (p.flashVenueKind != FlashVenueKind.Morpho) revert WrongCallbackForKind();
        if (p.helperAddress != address(this)) revert WrongHelper(p.helperAddress, address(this));

        address safeAddr = msg.sender;
        address midLoopFallback = _safeFallbackHandler(safeAddr);
        if (midLoopFallback != address(this)) revert NotMidLoop(safeAddr);

        address trailer = _extractTrailer();
        if (trailer != p.flashVenue) revert WrongTrailer(p.flashVenue, trailer);

        // Sanity check on Morpho callback parameters.
        if (assets != p.flashAmount) revert AmountMismatch(p.flashAmount, assets);

        // Execute the loop body (Boost or Repay). Morpho flash loans have no premium.
        _executeLoopBody(safeAddr, p, 0);

        // Approve Morpho to pull repayment (exact `assets`) from the Safe.
        _safeApprove(safeAddr, p.asset, p.flashVenue, assets);
    }

    /// @inheritdoc IFlashLoanHelper
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        override
        returns (bool)
    {
        LoopParams memory p = abi.decode(params, (LoopParams));

        // (Invariant 4 — callback authentication.)
        if (p.flashVenueKind != FlashVenueKind.Aave) revert WrongCallbackForKind();
        if (p.helperAddress != address(this)) revert WrongHelper(p.helperAddress, address(this));

        address safeAddr = msg.sender;
        address midLoopFallback = _safeFallbackHandler(safeAddr);
        if (midLoopFallback != address(this)) revert NotMidLoop(safeAddr);

        address trailer = _extractTrailer();
        if (trailer != p.flashVenue) revert WrongTrailer(p.flashVenue, trailer);

        // Sanity checks on Aave callback parameters.
        if (asset != p.asset) revert AssetMismatch(p.asset, asset);
        if (amount != p.flashAmount) revert AmountMismatch(p.flashAmount, amount);
        if (initiator != safeAddr) revert InitiatorMismatch(safeAddr, initiator);

        // Execute the loop body (Boost or Repay), accounting for Aave's flash-loan premium.
        _executeLoopBody(safeAddr, p, premium);

        // Approve Aave to pull repayment (amount + premium) from the Safe.
        _safeApprove(safeAddr, p.asset, p.flashVenue, amount + premium);

        return true;
    }

    // ---- Internal helpers ----

    /// @dev Inner loop body. Same-asset semantics: only one asset across supply/borrow/repay/withdraw.
    ///      `premium` is the flash-loan fee paid back to the flash venue (0 for Morpho, non-zero
    ///      for Aave). On Boost we need to borrow enough to cover both principal AND premium; on
    ///      Repay we need to withdraw enough to cover both.
    function _executeLoopBody(address safe, LoopParams memory p, uint256 premium) internal {
        if (p.direction == LoopDirection.Boost) {
            // Boost: supply `flashAmount`, borrow `flashAmount + premium`.
            _safeApprove(safe, p.asset, p.lendingVenue, p.flashAmount);
            _safeSupply(safe, p.lendingVenue, p.asset, p.flashAmount);
            _safeBorrow(safe, p.lendingVenue, p.asset, p.flashAmount + premium);
        } else if (p.direction == LoopDirection.Repay) {
            // Repay: repay `flashAmount` of debt, withdraw `flashAmount + premium`.
            _safeApprove(safe, p.asset, p.lendingVenue, p.flashAmount);
            _safeRepay(safe, p.lendingVenue, p.asset, p.flashAmount);
            _safeWithdraw(safe, p.lendingVenue, p.asset, p.flashAmount + premium);
        } else {
            revert InvalidDirection();
        }
    }

    /// @dev Have the Safe execute an arbitrary external call via the Safe Module mechanism.
    ///      Helper must be enabled as a Module on `safe`; if not, `execTransactionFromModule`
    ///      reverts. All callbacks rely on this — the callback runs in Helper's context, so the
    ///      only way to act on the Safe's positions is to route operations back through the Safe.
    function _safeExec(address safe, address target, bytes memory cd) internal {
        bool ok = ISafe(payable(safe)).execTransactionFromModule(target, 0, cd, Enum.Operation.Call);
        if (!ok) revert ExecTransactionFromModuleFailed();
    }

    function _safeApprove(address safe, address token, address spender, uint256 amount) internal {
        _safeExec(safe, token, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    function _safeSupply(address safe, address pool, address asset, uint256 amount) internal {
        _safeExec(safe, pool, abi.encodeCall(IPool.supply, (asset, amount, safe, 0)));
    }

    function _safeBorrow(address safe, address pool, address asset, uint256 amount) internal {
        _safeExec(safe, pool, abi.encodeCall(IPool.borrow, (asset, amount, AAVE_VARIABLE_RATE, 0, safe)));
    }

    function _safeRepay(address safe, address pool, address asset, uint256 amount) internal {
        _safeExec(safe, pool, abi.encodeCall(IPool.repay, (asset, amount, AAVE_VARIABLE_RATE, safe)));
    }

    function _safeWithdraw(address safe, address pool, address asset, uint256 amount) internal {
        _safeExec(safe, pool, abi.encodeCall(IPool.withdraw, (asset, amount, safe)));
    }

    /// @dev Reads the Safe's current fallback handler from its dedicated storage slot. Under
    ///      DELEGATECALL `sload(slot)` reads from `address(this)`'s storage, which is the Safe.
    function _currentFallbackHandler() internal view returns (address) {
        return _sloadAddress(FALLBACK_HANDLER_SLOT);
    }

    /// @dev Same read, but from outside the Safe's DELEGATECALL frame (i.e., from the callbacks,
    ///      which run in Helper's own context). Uses Safe's `getStorageAt` view function.
    function _safeFallbackHandler(address safe) internal view returns (address) {
        bytes memory raw = ISafe(payable(safe)).getStorageAt(uint256(FALLBACK_HANDLER_SLOT), 1);
        return abi.decode(raw, (address));
    }

    /// @dev Reads an address from a known Safe storage slot under DELEGATECALL — `sload(slot)`
    ///      reads from `address(this)`'s storage, which is the Safe. Used for the fallback
    ///      handler, Guard, and Module Guard slots.
    function _sloadAddress(bytes32 slot) internal view returns (address value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    /// @dev Hashes the Safe's modules list AND returns the next-pointer. Callers MUST check
    ///      `next == SENTINEL_MODULES` to confirm the entire list fits in one page; otherwise
    ///      the hash only covers the first `MODULES_PAGE_SIZE` entries and tampering beyond
    ///      the page would be invisible. See snapshot block + `TooManyModules`.
    function _modulesPage(ISafe safe) internal view returns (bytes32 hash, address next) {
        address[] memory mods;
        (mods, next) = safe.getModulesPaginated(SENTINEL_MODULES, MODULES_PAGE_SIZE);
        hash = keccak256(abi.encode(mods));
    }

    /// @dev Extracts the trailing 20-byte original-caller address that Safe's FallbackManager
    ///      appends to every fallback dispatch. See safe-smart-account/contracts/base/FallbackManager.sol.
    function _extractTrailer() internal pure returns (address) {
        return address(bytes20(msg.data[msg.data.length - 20:]));
    }
}
