import { describe, it, expect } from 'vitest';
import { concat, getAddress, keccak256, stringToHex, toFunctionSelector } from 'viem';
import {
  APPROVE_HASH_SELECTOR,
  SAFE_DOMAIN_SEPARATOR_TYPEHASH,
  SAFE_TX_TYPEHASH,
  computeSafeDomainSeparator,
  computeNestedApproveHashDetails,
} from '../../apply/nestedSafeHash';

describe('nestedSafeHash', () => {
  it('constants equal their canonical derivations', () => {
    expect(keccak256(stringToHex('EIP712Domain(uint256 chainId,address verifyingContract)'))).toBe(
      SAFE_DOMAIN_SEPARATOR_TYPEHASH,
    );
    expect(
      keccak256(
        stringToHex(
          'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)',
        ),
      ),
    ).toBe(SAFE_TX_TYPEHASH);
    expect(toFunctionSelector('approveHash(bytes32)')).toBe(APPROVE_HASH_SELECTOR);
  });

  // REAL golden vector, verified against a live Safe deployment: the child Safe
  // 0x8bcf… (an owner of parent 0x94656…) approves parent tx 0xdcef… by calling
  // parentSafe.approveHash(0xdcef…). The child's owners sign that child SafeTx.
  // chainId = sepolia. Child nonce = 1. All three hashes confirmed on-chain.
  const parentSafe = '0x94656Ee1C3256c08C9dcBA28dB5A3703643256b1';
  const parentSafeTxHash = '0xdcefd6565bd0887ba628283ccef168ed8e8a72aa3853a840fe126a8b1196d391';
  const childSafe = '0x8bcf74e03Bc81dAbAf4FDaAcbd3Ef28894ae8480';
  const args = {
    parentSafe,
    parentSafeTxHash,
    childSafe,
    childNonce: 1,
    chainId: 11155111,
  } as const;

  it('reproduces the on-chain-verified nested approveHash hashes', () => {
    const d = computeNestedApproveHashDetails(args);
    expect(d.domainHash).toBe('0xc3c3ff8330ded189aee81cab677a745ecc35372d5a35f01da3b6b152e90b2be2');
    expect(d.messageHash).toBe(
      '0x75a2f3948994cccd7dbb91eff53ed1cb78e5b5df211922092c1aac8a00eed0e4',
    );
    expect(d.safeTxHash).toBe('0x1c12554982ad86a2f92ad24bde0d97a70aea92bf7a05780a94bb9aa9652cb3e1');
  });

  it('builds approveHash(parentSafeTxHash) calldata', () => {
    expect(computeNestedApproveHashDetails(args).approveHashCalldata).toBe(
      concat([APPROVE_HASH_SELECTOR, parentSafeTxHash]),
    );
  });

  it('safeTxHash = keccak256(0x19 ‖ 0x01 ‖ domainHash ‖ messageHash)', () => {
    const d = computeNestedApproveHashDetails(args);
    expect(keccak256(concat(['0x19', '0x01', d.domainHash, d.messageHash]))).toBe(d.safeTxHash);
  });

  it('domainHash = computeSafeDomainSeparator(chainId, childSafe)', () => {
    expect(computeNestedApproveHashDetails(args).domainHash).toBe(
      computeSafeDomainSeparator(11155111, childSafe),
    );
  });

  it('the child nonce changes the hashes (nonce is part of the child SafeTx)', () => {
    const a = computeNestedApproveHashDetails(args);
    const b = computeNestedApproveHashDetails({ ...args, childNonce: 2 });
    expect(b.messageHash).not.toBe(a.messageHash);
    expect(b.safeTxHash).not.toBe(a.safeTxHash);
    expect(b.domainHash).toBe(a.domainHash); // domain is nonce-independent
  });

  it('treats number and bigint identically (chainId + nonce)', () => {
    const a = computeNestedApproveHashDetails(args);
    const b = computeNestedApproveHashDetails({ ...args, childNonce: 1n, chainId: 11155111n });
    expect(b.safeTxHash).toBe(a.safeTxHash);
  });

  it('is case-insensitive on addresses (encoded as raw bytes)', () => {
    const a = computeNestedApproveHashDetails(args);
    const b = computeNestedApproveHashDetails({
      ...args,
      parentSafe: getAddress(parentSafe).toLowerCase(),
      childSafe: getAddress(childSafe).toLowerCase(),
    });
    expect(b.safeTxHash).toBe(a.safeTxHash);
  });

  it('different chains produce different domain separators (replay isolation)', () => {
    expect(computeSafeDomainSeparator(1, childSafe)).not.toBe(
      computeSafeDomainSeparator(10, childSafe),
    );
  });
});
