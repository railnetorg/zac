import { describe, it, expect } from 'vitest';
import { buildFunctionParamMap } from '../../apply/buildFunctionParamMap';
import type { Generated } from '../../apply/parseGenerated';

function gen(
  target: string,
  fns: Array<{ signature: string; params?: unknown[] }>,
  roleKey = 'R',
): Generated {
  return {
    deployment: {
      chain_id: 1,
      safe_address: '0x3333333333333333333333333333333333333333',
      roles_modifier_address: '0x4444444444444444444444444444444444444444',
    },
    roles: {
      [roleKey]: {
        members: ['0x1111111111111111111111111111111111111111'],
        targets: [
          {
            address: target,
            functions: fns.map((f) => ({
              signature: f.signature,
              execution_options: 'none',
              params: f.params,
            })),
          },
        ],
      },
    },
  } as Generated;
}

describe('buildFunctionParamMap', () => {
  it('keys by `<role>:<target_lower>:<selector_lower>` and captures parsed inputs + raw params', () => {
    const m = buildFunctionParamMap([
      gen('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', [
        {
          signature: 'function approve(address spender, uint256 amount)',
          params: [
            { name: 'spender', operator: 'equal_to_avatar' },
            { name: 'amount', operator: 'pass' },
          ],
        },
      ]),
    ]);
    const entry = m['R:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:0x095ea7b3'];
    expect(entry).toBeDefined();
    expect(entry?.fnName).toBe('approve');
    expect(entry?.inputs.map((i) => `${i.type} ${i.name ?? ''}`)).toEqual([
      'address spender',
      'uint256 amount',
    ]);
    expect(entry?.params).toHaveLength(2);
    expect(entry?.params[0]?.operator).toBe('equal_to_avatar');
    expect(entry?.params[1]?.operator).toBe('pass');
  });

  it('parses tuple signatures into components (Morpho-Blue `marketParams`)', () => {
    const m = buildFunctionParamMap([
      gen('0xBBBBBBbbbBbBbbBBbBBbbbbBBBbbBBBBBb8FBB99', [
        {
          signature:
            'function supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data)',
          params: [{ name: 'marketParams', operator: 'matches', conditions: [] }],
        },
      ]),
    ]);
    const key = Object.keys(m)[0]!;
    const entry = m[key]!;
    expect(entry.inputs[0]?.type).toBe('tuple');
    expect(entry.inputs[0]?.name).toBe('marketParams');
    expect(entry.inputs[0]?.components?.map((c) => `${c.type} ${c.name ?? ''}`)).toEqual([
      'address loanToken',
      'address collateralToken',
      'address oracle',
      'address irm',
      'uint256 lltv',
    ]);
  });

  it('first-seen wins on (role, target, selector) collision', () => {
    const m = buildFunctionParamMap([
      gen('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', [
        { signature: 'function approve(address spender, uint256 amount)', params: [] },
      ]),
      gen('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', [
        // Same role (R), same target, same selector — second occurrence ignored.
        {
          signature: 'function approve(address a, uint256 b)',
          params: [{ name: 'a', operator: 'pass' }],
        },
      ]),
    ]);
    const entry = m['R:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:0x095ea7b3'];
    expect(entry?.inputs[0]?.name).toBe('spender');
  });

  it('same target+selector across DIFFERENT roles keep separate entries (role-keyed)', () => {
    // Repro for the plan-diff bug: every protocol approves USDC, each pinning
    // its own spender. Keyed by target:selector alone these collided and the
    // diff showed the first role's spender (aave.pool) on every approve line.
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
    const ONDO_ROUTER = '0x2c158BC456e027b2AfFCCadF1BDBD9f5fC4c5C8c';
    const approveWith = (spender: string) => ({
      signature: 'function approve(address spender, uint256 amount)',
      params: [
        { name: 'spender', operator: 'equal_to', value: spender, value_type: 'address' },
        { name: 'amount', operator: 'pass' },
      ],
    });
    const m = buildFunctionParamMap([
      gen(USDC, [approveWith(AAVE_POOL)], 'AAVE_V3'),
      gen(USDC, [approveWith(ONDO_ROUTER)], 'ONDO_GM'),
    ]);
    const usdc = USDC.toLowerCase();
    expect(Object.keys(m)).toHaveLength(2);
    expect(m[`AAVE_V3:${usdc}:0x095ea7b3`]?.params[0]?.['value']).toBe(AAVE_POOL);
    expect(m[`ONDO_GM:${usdc}:0x095ea7b3`]?.params[0]?.['value']).toBe(ONDO_ROUTER);
  });

  it('different targets, same selector keep separate entries', () => {
    const m = buildFunctionParamMap([
      gen('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', [
        { signature: 'function approve(address spender, uint256 amount)', params: [] },
      ]),
      gen('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', [
        { signature: 'function approve(address spender, uint256 amount)', params: [] },
      ]),
    ]);
    expect(Object.keys(m)).toHaveLength(2);
  });

  it('malformed signatures are skipped silently', () => {
    const m = buildFunctionParamMap([
      gen('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', [
        { signature: 'this is not a signature', params: [] },
        { signature: 'function approve(address spender, uint256 amount)', params: [] },
      ]),
    ]);
    expect(Object.keys(m)).toHaveLength(1);
    expect(Object.keys(m)[0]).toContain(':0x095ea7b3');
  });
});
