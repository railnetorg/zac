import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';

/**
 * EIP-712 domain-separator typehash used by Safe contracts v1.3.0+:
 *   keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
 *
 * Pre-1.3.0 Safes use a chainId-less domain (`EIP712Domain(address
 * verifyingContract)`); those are NOT supported here — every Safe this tool
 * targets is v1.3.0 or later (same assumption as `SAFE_TX_TYPES` in safeApi).
 */
export const SAFE_DOMAIN_SEPARATOR_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const;

/**
 * SafeMessage struct typehash, shared by Safe's `SignMessageLib` and
 * `CompatibilityFallbackHandler`:
 *   keccak256("SafeMessage(bytes message)")
 */
export const SAFE_MSG_TYPEHASH =
  '0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca' as const;

/**
 * Compute a Safe's EIP-712 domain separator (v1.3.0+):
 *   keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, safe))
 *
 * Address case is irrelevant — viem encodes the `address` as its raw 20
 * bytes, so a lowercased and a checksummed spelling hash identically.
 */
export function computeSafeDomainSeparator(chainId: number | bigint, safe: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [SAFE_DOMAIN_SEPARATOR_TYPEHASH, BigInt(chainId), safe as Hex],
    ),
  );
}

export interface NestedSafeMessageHashArgs {
  /** The parent Safe's `safeTxHash` — the 32-byte digest the parent verifies. */
  parentSafeTxHash: string;
  /**
   * A parent-Safe owner that is ITSELF a Safe (the "nested signer"). Its own
   * signers produce the EIP-1271 contract signature that approves the parent
   * transaction.
   */
  childSafe: string;
  /**
   * Chain of BOTH safes. A Safe owner is an address on the same chain as the
   * parent, so the child's domain separator uses the parent's chainId.
   */
  chainId: number | bigint;
}

/**
 * The three hashes a hardware wallet (e.g. Ledger) surfaces when a CHILD
 * Safe's owner signs the EIP-1271 SafeMessage that approves the PARENT
 * Safe's transaction:
 *
 * - `domainHash`: the child Safe's EIP-712 domain separator — what a Ledger
 *    labels "Domain hash".
 * - `messageHash`: the SafeMessage STRUCT hash
 *    (`keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(parentSafeTxHash)))`)
 *    — what a Ledger labels "Message hash".
 * - `nestedHash`: the final EIP-712 digest
 *    (`keccak256(0x19 ‖ 0x01 ‖ domainHash ‖ messageHash)`) — the value
 *    actually signed/approved.
 */
export interface NestedSafeMessageDetails {
  domainHash: Hex;
  messageHash: Hex;
  nestedHash: Hex;
}

/**
 * Compute all three Ledger-visible hashes for the CHILD Safe's EIP-1271
 * approval of the PARENT Safe's transaction. This reproduces
 * `getMessageHashForSafe(childSafe, abi.encode(parentSafeTxHash))` from
 * Safe's `CompatibilityFallbackHandler`:
 *
 *   domainHash  = domainSeparator(childSafe)
 *   messageHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(parentSafeTxHash)))
 *   nestedHash  = keccak256(0x19 ‖ 0x01 ‖ domainHash ‖ messageHash)
 *
 * (`abi.encode(bytes32)` is the 32 bytes themselves, so the EIP-712 `bytes`
 * pre-hash is `keccak256(parentSafeTxHash)`.) `messageHash` is the
 * intermediate struct hash a Ledger labels "Message hash"; `nestedHash` is
 * the final signed digest.
 *
 * Single level of nesting only — a child Safe that itself has Safe owners is
 * not recursed.
 */
export function computeNestedSafeMessageDetails(
  args: NestedSafeMessageHashArgs,
): NestedSafeMessageDetails {
  const domainHash = computeSafeDomainSeparator(args.chainId, args.childSafe);
  const messageHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [SAFE_MSG_TYPEHASH, keccak256(args.parentSafeTxHash as Hex)],
    ),
  );
  const nestedHash = keccak256(concat(['0x19', '0x01', domainHash, messageHash]));
  return { domainHash, messageHash, nestedHash };
}

/**
 * Convenience wrapper returning only the final signed digest (`nestedHash`)
 * — kept for back-compat with callers that don't need the intermediate
 * domain/message hashes. Delegates to `computeNestedSafeMessageDetails` so
 * the hashing logic lives in exactly one place.
 */
export function computeNestedSafeMessageHash(args: NestedSafeMessageHashArgs): Hex {
  return computeNestedSafeMessageDetails(args).nestedHash;
}
