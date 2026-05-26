import { describe, it, expect } from 'vitest';
import { buildAddressLabelMap } from '../../apply/buildAddressLabelMap';
import type { AliasRegistry } from '../../load/loadAllAliases';

function reg(merged: Record<string, unknown>): AliasRegistry {
  return { merged };
}

describe('buildAddressLabelMap', () => {
  it('flat string→address leaves render as namespace.key (lowercase)', () => {
    const m = buildAddressLabelMap(
      reg({
        tokens: {
          USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        },
        aave: { pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
      }),
    );
    // Map keys are lowercased — preserves the checksum-insensitive lookup
    // contract the printer relies on.
    expect(m['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']).toBe('tokens.USDC');
    expect(m['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']).toBe('tokens.WETH');
    expect(m['0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2']).toBe('aave.pool');
  });

  it('object with `address` field uses parent path (not `<entry>.address`)', () => {
    const m = buildAddressLabelMap(
      reg({
        metamorpho: {
          steakhouse_usdc: {
            address: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB',
            asset: 'USDC',
          },
        },
      }),
    );
    expect(m['0xbeef01735c132ada46aa9aa4c54623caa92a64cb']).toBe('metamorpho.steakhouse_usdc');
    // Sibling `asset: "USDC"` is a non-address symbol — must not pollute the map.
    expect(Object.values(m)).not.toContain('metamorpho.steakhouse_usdc.asset');
  });

  it('non-address string leaves are silently skipped', () => {
    const m = buildAddressLabelMap(
      reg({
        labels: {
          name: 'My Safe',
          description: 'a non-address string',
          truncated: '0x123', // too short to be an address
        },
      }),
    );
    expect(m).toEqual({});
  });

  it('first-seen wins on collision (same address aliased twice)', () => {
    const m = buildAddressLabelMap(
      reg({
        tokens: { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        // Alias whose value collides with tokens.USDC — first-seen wins.
        legacy: { stablecoin: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
      }),
    );
    expect(m['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']).toBe('tokens.USDC');
  });

  it('nested namespace objects without an `address` field recurse', () => {
    const m = buildAddressLabelMap(
      reg({
        chains: {
          mainnet: {
            uniswap: { router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' },
          },
        },
      }),
    );
    expect(m['0x7a250d5630b4cf539739df2c5dacb4c659f2488d']).toBe('chains.mainnet.uniswap.router');
  });

  it('arrays and null/undefined leaves are ignored', () => {
    const m = buildAddressLabelMap(
      reg({
        addresses: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
        nullField: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        undefinedField: undefined as any,
      }),
    );
    // Arrays are skipped — the `address: "0x..."` shape is the only way to
    // surface a labeled address from a non-leaf node.
    expect(m).toEqual({});
  });
});
