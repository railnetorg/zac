import { describe, it, expect } from 'vitest';
import { safeServiceUrlForChain } from '../../apply/safeServiceUrl';

describe('safeServiceUrlForChain', () => {
  it('T11-7: known chains map to a Safe Transaction Service URL', () => {
    expect(safeServiceUrlForChain(1)).toBe('https://safe-transaction-mainnet.safe.global/api');
    expect(safeServiceUrlForChain(137)).toBe('https://safe-transaction-polygon.safe.global/api');
    expect(safeServiceUrlForChain(8453)).toBe('https://safe-transaction-base.safe.global/api');
    expect(safeServiceUrlForChain(11155111)).toBe(
      'https://safe-transaction-sepolia.safe.global/api',
    );
  });

  it('T11-8: unknown chain → null', () => {
    expect(safeServiceUrlForChain(999_999)).toBeNull();
    expect(safeServiceUrlForChain(0)).toBeNull();
  });
});
