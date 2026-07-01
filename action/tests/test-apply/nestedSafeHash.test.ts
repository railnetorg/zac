import { describe, it, expect } from 'vitest';
import { getAddress, keccak256, stringToHex } from 'viem';
import {
  SAFE_DOMAIN_SEPARATOR_TYPEHASH,
  SAFE_MSG_TYPEHASH,
  computeSafeDomainSeparator,
  computeNestedSafeMessageHash,
  computeNestedSafeMessageDetails,
} from '../../apply/nestedSafeHash';

describe('nestedSafeHash', () => {
  it('typehash constants equal the keccak256 of their EIP-712 type strings', () => {
    expect(keccak256(stringToHex('EIP712Domain(uint256 chainId,address verifyingContract)'))).toBe(
      SAFE_DOMAIN_SEPARATOR_TYPEHASH,
    );
    expect(keccak256(stringToHex('SafeMessage(bytes message)'))).toBe(SAFE_MSG_TYPEHASH);
  });

  // Golden vector — cross-checked independently with two encodings (viem
  // `encodeAbiParameters` vs raw 32-byte concatenation), and the typehashes
  // match Safe's vendored contracts. chainId=1, child=0x1111…, parent=0x2222…
  const child = '0x1111111111111111111111111111111111111111';
  const parentSafeTxHash = '0x2222222222222222222222222222222222222222222222222222222222222222';

  it('computeSafeDomainSeparator matches the golden vector', () => {
    expect(computeSafeDomainSeparator(1, child)).toBe(
      '0xf0dcfe86ad4a409690a57dbaae9b1e14c5ea1750a48271a0a3a6037a8100624d',
    );
  });

  it('computeNestedSafeMessageHash matches the golden vector', () => {
    expect(computeNestedSafeMessageHash({ parentSafeTxHash, childSafe: child, chainId: 1 })).toBe(
      '0x67b819bcfb62ac70998252080275238fe2f55807caf34121c945dfcd73dbc466',
    );
  });

  it('computeNestedSafeMessageDetails returns the three golden hashes (domain/message/nested)', () => {
    const details = computeNestedSafeMessageDetails({
      parentSafeTxHash,
      childSafe: child,
      chainId: 1,
    });
    expect(details.domainHash).toBe(
      '0xf0dcfe86ad4a409690a57dbaae9b1e14c5ea1750a48271a0a3a6037a8100624d',
    );
    expect(details.messageHash).toBe(
      '0xbe7fb89ad4f22d06aadb5902e31095068172092735365192feef3a063f7d4a78',
    );
    expect(details.nestedHash).toBe(
      '0x67b819bcfb62ac70998252080275238fe2f55807caf34121c945dfcd73dbc466',
    );
  });

  it('computeNestedSafeMessageHash equals computeNestedSafeMessageDetails().nestedHash (no duplicated logic)', () => {
    const args = { parentSafeTxHash, childSafe: child, chainId: 1 } as const;
    expect(computeNestedSafeMessageHash(args)).toBe(
      computeNestedSafeMessageDetails(args).nestedHash,
    );
  });

  it('details.domainHash equals computeSafeDomainSeparator(chainId, childSafe)', () => {
    const args = { parentSafeTxHash, childSafe: child, chainId: 1 } as const;
    expect(computeNestedSafeMessageDetails(args).domainHash).toBe(
      computeSafeDomainSeparator(1, child),
    );
  });

  it('treats number and bigint chainId identically', () => {
    expect(computeSafeDomainSeparator(1n, child)).toBe(computeSafeDomainSeparator(1, child));
    expect(computeNestedSafeMessageHash({ parentSafeTxHash, childSafe: child, chainId: 1n })).toBe(
      computeNestedSafeMessageHash({ parentSafeTxHash, childSafe: child, chainId: 1 }),
    );
  });

  it('is case-insensitive on the child address (encoded as raw bytes)', () => {
    // A child WITH hex letters so lowercase vs checksummed actually differ.
    const lower = '0xabcdef0123456789abcdef0123456789abcdef01';
    const checksummed = getAddress(lower);
    expect(checksummed).not.toBe(lower); // sanity: the two spellings differ
    expect(computeSafeDomainSeparator(1, checksummed)).toBe(computeSafeDomainSeparator(1, lower));
    expect(
      computeNestedSafeMessageHash({ parentSafeTxHash, childSafe: checksummed, chainId: 1 }),
    ).toBe(computeNestedSafeMessageHash({ parentSafeTxHash, childSafe: lower, chainId: 1 }));
  });

  it('different chains produce different domain separators (replay isolation)', () => {
    expect(computeSafeDomainSeparator(1, child)).not.toBe(computeSafeDomainSeparator(10, child));
  });
});
