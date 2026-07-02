import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/**
 * EIP-712 domain-separator typehash used by Safe contracts v1.3.0+:
 *   keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
 *
 * Pre-1.3.0 Safes use a chainId-less domain; not supported here (every Safe
 * this tool targets is v1.3.0+ — same assumption as `SAFE_TX_TYPES` in safeApi).
 */
export const SAFE_DOMAIN_SEPARATOR_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const;

/**
 * EIP-712 SafeTx struct typehash (Safe v1.3.0+):
 *   keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,
 *     uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,
 *     address refundReceiver,uint256 nonce)")
 */
export const SAFE_TX_TYPEHASH =
  '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8' as const;

/** 4-byte selector of `approveHash(bytes32)` on the Safe contract. */
export const APPROVE_HASH_SELECTOR = '0xd4d9bdcd' as const;

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

export interface NestedApproveHashArgs {
  /**
   * The PARENT Safe whose transaction is being approved. The child Safe is an
   * owner of it, and approves by calling `parentSafe.approveHash(...)`.
   */
  parentSafe: string;
  /** The parent Safe transaction hash the child approves. */
  parentSafeTxHash: string;
  /**
   * The nested-signer CHILD Safe — an owner of the parent that is itself a
   * Safe. Its OWN owners sign the child transaction below.
   */
  childSafe: string;
  /**
   * The child Safe's current `nonce()` — the child's `approveHash` transaction
   * uses it, so the hashes are nonce-derived (read live; re-verify at submit).
   */
  childNonce: number | bigint;
  /** Chain of both safes (a Safe owner lives on the parent's chain). */
  chainId: number | bigint;
}

/**
 * The hashes a hardware wallet (e.g. Ledger) surfaces when a CHILD Safe's owner
 * signs the transaction that approves the PARENT Safe's transaction.
 *
 * - `domainHash`: the child Safe's EIP-712 domain separator ("Domain hash").
 * - `messageHash`: the child `SafeTx` STRUCT hash ("Message hash").
 * - `safeTxHash`: the child transaction's final EIP-712 digest — the value the
 *    child's owners actually sign.
 * - `approveHashCalldata`: the `approveHash(parentSafeTxHash)` calldata the
 *    child executes on the parent.
 */
export interface NestedApproveHashDetails {
  domainHash: Hex;
  messageHash: Hex;
  safeTxHash: Hex;
  approveHashCalldata: Hex;
}

/**
 * Compute the child-Safe transaction hashes for the standard Safe NESTED
 * approval flow: a child Safe that is an owner of the parent approves the
 * parent's transaction by executing `parentSafe.approveHash(parentSafeTxHash)`.
 * The child's own owners sign that child transaction, so what they verify on a
 * Ledger is the child `SafeTx` — NOT an EIP-1271 `SafeMessage`.
 *
 *   approveHashCalldata = approveHash(bytes32) selector ‖ parentSafeTxHash
 *   domainHash  = domainSeparator(childSafe)
 *   messageHash = keccak256(abi.encode(SAFE_TX_TYPEHASH, parentSafe, 0,
 *                   keccak256(approveHashCalldata), 0 (CALL), 0, 0, 0,
 *                   address(0), address(0), childNonce))
 *   safeTxHash  = keccak256(0x19 ‖ 0x01 ‖ domainHash ‖ messageHash)
 *
 * All gas fields, gasToken and refundReceiver are zero (the default Safe tx a
 * wallet builds for an `approveHash` call). Single level of nesting only.
 */
export function computeNestedApproveHashDetails(
  args: NestedApproveHashArgs,
): NestedApproveHashDetails {
  const approveHashCalldata = concat([APPROVE_HASH_SELECTOR, args.parentSafeTxHash as Hex]);
  const domainHash = computeSafeDomainSeparator(args.chainId, args.childSafe);
  const messageHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, // SAFE_TX_TYPEHASH
        { type: 'address' }, // to           = parentSafe
        { type: 'uint256' }, // value        = 0
        { type: 'bytes32' }, // keccak256(data)
        { type: 'uint8' }, //   operation    = 0 (CALL)
        { type: 'uint256' }, // safeTxGas    = 0
        { type: 'uint256' }, // baseGas      = 0
        { type: 'uint256' }, // gasPrice     = 0
        { type: 'address' }, // gasToken     = address(0)
        { type: 'address' }, // refundReceiver = address(0)
        { type: 'uint256' }, // nonce        = childNonce
      ],
      [
        SAFE_TX_TYPEHASH,
        args.parentSafe as Hex,
        0n,
        keccak256(approveHashCalldata),
        0,
        0n,
        0n,
        0n,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        BigInt(args.childNonce),
      ],
    ),
  );
  const safeTxHash = keccak256(concat(['0x19', '0x01', domainHash, messageHash]));
  return { domainHash, messageHash, safeTxHash, approveHashCalldata };
}
