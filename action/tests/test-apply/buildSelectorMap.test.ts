import { describe, it, expect } from 'vitest';
import { buildSelectorMap } from '../../apply/buildSelectorMap';
import type { Generated } from '../../apply/parseGenerated';

/**
 * Build a minimal Generated fixture with the given function signatures
 * under a single role's single target.
 */
function gen(signatures: string[]): Generated {
  return {
    deployment: {
      chain_id: 1,
      safe_address: '0x4444444444444444444444444444444444444444',
      roles_modifier_address: '0x5555555555555555555555555555555555555555',
    },
    roles: {
      TEST: {
        members: ['0x1111111111111111111111111111111111111111'],
        targets: [
          {
            address: '0x2222222222222222222222222222222222222222',
            functions: signatures.map((sig) => ({ signature: sig })),
          },
        ],
      },
    },
  };
}

describe('buildSelectorMap', () => {
  it('TBS-1: maps a single signature with named params to its function name', () => {
    const m = buildSelectorMap([gen(['function approve(address spender, uint256 amount)'])]);
    // approve(address,uint256) → 0x095ea7b3
    expect(m['0x095ea7b3']).toBe('approve');
  });

  it('TBS-2: maps a canonical-form signature (no `function ` prefix, no names)', () => {
    const m = buildSelectorMap([gen(['transfer(address,uint256)'])]);
    expect(m['0xa9059cbb']).toBe('transfer');
  });

  it('TBS-3: aggregates across multiple generated configs', () => {
    const m = buildSelectorMap([
      gen(['function approve(address spender, uint256 amount)']),
      gen([
        'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
      ]),
    ]);
    expect(m['0x095ea7b3']).toBe('approve');
    expect(Object.values(m)).toContain('supply');
  });

  it('TBS-4: malformed signatures are silently skipped (do not throw)', () => {
    const m = buildSelectorMap([
      gen(['not a real signature', 'function approve(address,uint256)']),
    ]);
    expect(m['0x095ea7b3']).toBe('approve');
  });

  it('TBS-5: empty input produces empty map', () => {
    expect(buildSelectorMap([])).toEqual({});
  });

  it('TBS-6: selector keys are lowercased', () => {
    const m = buildSelectorMap([gen(['function approve(address,uint256)'])]);
    const keys = Object.keys(m);
    expect(keys.every((k) => k === k.toLowerCase())).toBe(true);
  });
});
