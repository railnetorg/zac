// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {FlashLoanHelper} from "src/FlashLoanHelper.sol";
import {IFlashLoanHelper} from "src/interfaces/IFlashLoanHelper.sol";

/// @dev Minimal Safe stand-in. Implements just enough of `ISafe` for the unit tests:
///      a configurable fallback-handler slot reader, plus a fallback-handler simulator that
///      appends `msg.sender` to the calldata before forwarding — the same trailer convention
///      Safe v1.4 `FallbackManager` uses. No real Safe semantics (modules, owners, threshold);
///      those are exercised in fork tests with the actual Safe contracts.
contract MockSafeForCallback {
    address public fallbackHandler;

    function setFallbackHandler(address h) external {
        fallbackHandler = h;
    }

    /// Mirrors `IStorageAccessible.getStorageAt` for the single slot the Helper reads.
    function getStorageAt(uint256, uint256) external view returns (bytes memory) {
        return abi.encode(fallbackHandler);
    }

    /// Mirrors `Safe.fallback`: forward to the fallback handler via CALL, appending a 20-byte
    /// trailer (the original caller in Safe; arbitrary here so tests can drive trailer values).
    function forwardWithTrailer(address handler, bytes calldata callData, address trailer) external {
        bytes memory withTrailer = abi.encodePacked(callData, bytes20(trailer));
        (bool ok, bytes memory ret) = handler.call(withTrailer);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

contract FlashLoanHelperTest is Test {
    FlashLoanHelper helper;
    MockSafeForCallback safe;

    address constant LENDING_VENUE = address(0xAAA1);
    address constant ASSET = address(0xBBBB);
    address constant FLASH_VENUE_MORPHO = address(0xCCCC);
    address constant FLASH_VENUE_AAVE = address(0xDDDD);
    uint256 constant FLASH_AMOUNT = 1_000_000e6;
    uint256 constant MIN_HF = 1.1e18;

    function setUp() public {
        helper = new FlashLoanHelper();
        safe = new MockSafeForCallback();
    }

    // ==================== Invariant 1 — Statelessness ====================

    /// Helper declares zero storage variables; slot 0 (and any reasonable scan range) reads
    /// back as zero. Full audit-grade check is `forge inspect FlashLoanHelper storageLayout`
    /// returning an empty layout; this is the cheap runtime equivalent.
    function test_storageSlotZeroIsEmpty() public view {
        bytes32 slot0 = vm.load(address(helper), bytes32(uint256(0)));
        assertEq(slot0, bytes32(0));
    }

    // ==================== Invariant 7 — Direct-call rejection on executeLoop ====================

    /// A direct CALL on the Helper deployment (i.e., not DELEGATECALL from a Safe) is rejected.
    /// Detection: `address(this) == SELF` only when running directly on the Helper contract;
    /// under DELEGATECALL `address(this)` would be the Safe.
    function test_executeLoop_revertsOnDirectCall() public {
        IFlashLoanHelper.LoopParams memory p = _defaultMorphoParams();

        vm.expectRevert(FlashLoanHelper.MustDelegateCall.selector);
        helper.executeLoop(p);
    }

    // ==================== Invariant 4 — Callback authentication ====================

    // ---- onMorphoFlashLoan ----

    /// Wrong `flashVenueKind` in the payload — caller is invoking the Morpho callback but the
    /// loop params say "Aave flash". This catches a confused or malicious caller crafting params
    /// for the wrong protocol.
    function test_onMorphoFlashLoan_revertsOnWrongCallbackKind() public {
        IFlashLoanHelper.LoopParams memory p = _defaultMorphoParams();
        p.flashVenueKind = IFlashLoanHelper.FlashVenueKind.Aave;

        vm.expectRevert(FlashLoanHelper.WrongCallbackForKind.selector);
        helper.onMorphoFlashLoan(FLASH_AMOUNT, abi.encode(p));
    }

    /// `msg.sender` (a Safe-shaped contract) doesn't currently have the Helper installed as its
    /// fallback handler — meaning either: no loop in flight, or a misconfigured Safe. Either
    /// way, the callback is not authenticated.
    function test_onMorphoFlashLoan_revertsWhenSafeHasNoFallbackHandler() public {
        IFlashLoanHelper.LoopParams memory p = _defaultMorphoParams();
        // safe.fallbackHandler defaults to address(0) — i.e., no fallback installed.

        bytes memory cd = abi.encodeCall(IFlashLoanHelper.onMorphoFlashLoan, (FLASH_AMOUNT, abi.encode(p)));

        vm.expectRevert(abi.encodeWithSelector(FlashLoanHelper.NotMidLoop.selector, address(safe)));
        safe.forwardWithTrailer(address(helper), cd, FLASH_VENUE_MORPHO);
    }

    /// Safe has Helper as fallback handler (mid-loop indicator passes), but the trailer
    /// (Safe's appended original caller) doesn't match the expected flash venue. Catches the
    /// case where some non-flash-venue triggered Safe.fallback into Helper.
    function test_onMorphoFlashLoan_revertsOnWrongTrailer() public {
        IFlashLoanHelper.LoopParams memory p = _defaultMorphoParams();
        safe.setFallbackHandler(address(helper));

        bytes memory cd = abi.encodeCall(IFlashLoanHelper.onMorphoFlashLoan, (FLASH_AMOUNT, abi.encode(p)));
        address attacker = address(0xBADBAD);

        vm.expectRevert(abi.encodeWithSelector(FlashLoanHelper.WrongTrailer.selector, FLASH_VENUE_MORPHO, attacker));
        safe.forwardWithTrailer(address(helper), cd, attacker);
    }

    /// `assets` parameter from the flash venue doesn't match the encoded `p.flashAmount`. A
    /// well-behaved flash venue won't violate this; the check is a defense against the venue
    /// being compromised or buggy.
    function test_onMorphoFlashLoan_revertsOnAmountMismatch() public {
        IFlashLoanHelper.LoopParams memory p = _defaultMorphoParams();
        safe.setFallbackHandler(address(helper));

        uint256 wrongAmount = FLASH_AMOUNT + 1;
        bytes memory cd = abi.encodeCall(IFlashLoanHelper.onMorphoFlashLoan, (wrongAmount, abi.encode(p)));

        vm.expectRevert(abi.encodeWithSelector(FlashLoanHelper.AmountMismatch.selector, FLASH_AMOUNT, wrongAmount));
        safe.forwardWithTrailer(address(helper), cd, FLASH_VENUE_MORPHO);
    }

    // ---- executeOperation (Aave) ----

    function test_executeOperation_revertsOnWrongCallbackKind() public {
        IFlashLoanHelper.LoopParams memory p = _defaultAaveParams();
        p.flashVenueKind = IFlashLoanHelper.FlashVenueKind.Morpho;

        vm.expectRevert(FlashLoanHelper.WrongCallbackForKind.selector);
        helper.executeOperation(ASSET, FLASH_AMOUNT, 0, address(this), abi.encode(p));
    }

    function test_executeOperation_revertsWhenSafeHasNoFallbackHandler() public {
        IFlashLoanHelper.LoopParams memory p = _defaultAaveParams();

        bytes memory cd =
            abi.encodeCall(IFlashLoanHelper.executeOperation, (ASSET, FLASH_AMOUNT, 0, address(safe), abi.encode(p)));

        vm.expectRevert(abi.encodeWithSelector(FlashLoanHelper.NotMidLoop.selector, address(safe)));
        safe.forwardWithTrailer(address(helper), cd, FLASH_VENUE_AAVE);
    }

    function test_executeOperation_revertsOnWrongTrailer() public {
        IFlashLoanHelper.LoopParams memory p = _defaultAaveParams();
        safe.setFallbackHandler(address(helper));

        bytes memory cd =
            abi.encodeCall(IFlashLoanHelper.executeOperation, (ASSET, FLASH_AMOUNT, 0, address(safe), abi.encode(p)));
        address attacker = address(0xBADBAD);

        vm.expectRevert(abi.encodeWithSelector(FlashLoanHelper.WrongTrailer.selector, FLASH_VENUE_AAVE, attacker));
        safe.forwardWithTrailer(address(helper), cd, attacker);
    }

    function test_executeOperation_revertsOnAssetMismatch() public {
        IFlashLoanHelper.LoopParams memory p = _defaultAaveParams();
        safe.setFallbackHandler(address(helper));

        address wrongAsset = address(0xFAFA);
        bytes memory cd = abi.encodeCall(
            IFlashLoanHelper.executeOperation, (wrongAsset, FLASH_AMOUNT, 0, address(safe), abi.encode(p))
        );

        vm.expectRevert(abi.encodeWithSelector(FlashLoanHelper.AssetMismatch.selector, ASSET, wrongAsset));
        safe.forwardWithTrailer(address(helper), cd, FLASH_VENUE_AAVE);
    }

    function test_executeOperation_revertsOnAmountMismatch() public {
        IFlashLoanHelper.LoopParams memory p = _defaultAaveParams();
        safe.setFallbackHandler(address(helper));

        uint256 wrongAmount = FLASH_AMOUNT + 1;
        bytes memory cd =
            abi.encodeCall(IFlashLoanHelper.executeOperation, (ASSET, wrongAmount, 0, address(safe), abi.encode(p)));

        vm.expectRevert(abi.encodeWithSelector(FlashLoanHelper.AmountMismatch.selector, FLASH_AMOUNT, wrongAmount));
        safe.forwardWithTrailer(address(helper), cd, FLASH_VENUE_AAVE);
    }

    /// `initiator` is the address that originated the Aave flash loan. In our flow it must be
    /// the Safe (since the Safe is `msg.sender` to `flashLoanSimple`). Any other initiator means
    /// the callback isn't part of our orchestrated loop.
    function test_executeOperation_revertsOnInitiatorMismatch() public {
        IFlashLoanHelper.LoopParams memory p = _defaultAaveParams();
        safe.setFallbackHandler(address(helper));

        address wrongInitiator = address(0xEEEE);
        bytes memory cd =
            abi.encodeCall(IFlashLoanHelper.executeOperation, (ASSET, FLASH_AMOUNT, 0, wrongInitiator, abi.encode(p)));

        vm.expectRevert(
            abi.encodeWithSelector(FlashLoanHelper.InitiatorMismatch.selector, address(safe), wrongInitiator)
        );
        safe.forwardWithTrailer(address(helper), cd, FLASH_VENUE_AAVE);
    }

    // ==================== Helpers ====================

    function _defaultMorphoParams() internal pure returns (IFlashLoanHelper.LoopParams memory) {
        return IFlashLoanHelper.LoopParams({
            direction: IFlashLoanHelper.LoopDirection.Boost,
            lendingVenue: LENDING_VENUE,
            asset: ASSET,
            flashAmount: FLASH_AMOUNT,
            flashVenue: FLASH_VENUE_MORPHO,
            flashVenueKind: IFlashLoanHelper.FlashVenueKind.Morpho,
            minHealthFactor: MIN_HF
        });
    }

    function _defaultAaveParams() internal pure returns (IFlashLoanHelper.LoopParams memory) {
        return IFlashLoanHelper.LoopParams({
            direction: IFlashLoanHelper.LoopDirection.Boost,
            lendingVenue: LENDING_VENUE,
            asset: ASSET,
            flashAmount: FLASH_AMOUNT,
            flashVenue: FLASH_VENUE_AAVE,
            flashVenueKind: IFlashLoanHelper.FlashVenueKind.Aave,
            minHealthFactor: MIN_HF
        });
    }
}
