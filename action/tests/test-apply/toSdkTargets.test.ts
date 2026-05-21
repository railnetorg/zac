import { describe, it, expect } from 'vitest';
import { toSdkTargets } from '../../apply/toSdkTargets';
import { ZacError } from '../../errors';
import type { Generated } from '../../apply/parseGenerated';

// Recording stub for the SDK `c` namespace. Each builder returns a tagged
// node so the resulting scoping tree can be deep-equaled.
function recordingC() {
  const passToken = { kind: 'pass' };
  const avatarToken = { kind: 'avatar' };
  let processPermissionsArg: unknown = null;
  return {
    c: {
      eq: (v: unknown) => ({ kind: 'eq', value: v }),
      gt: (v: unknown) => ({ kind: 'gt', value: v }),
      lt: (v: unknown) => ({ kind: 'lt', value: v }),
      or: (...args: unknown[]) => ({ kind: 'or', branches: args }),
      matches: (scoping: unknown[]) => ({ kind: 'matches', scoping }),
      pass: passToken,
      calldataMatches: (scoping: unknown, abiTypes: readonly string[]) => ({
        kind: 'calldataMatches',
        scoping,
        abiTypes: [...abiTypes],
      }),
      avatar: avatarToken,
    },
    processPermissions: (perms: unknown[]) => {
      processPermissionsArg = perms;
      return { targets: perms };
    },
    getProcessPermissionsArg: () => processPermissionsArg,
  };
}

function makeGenerated(target: {
  address: string;
  functions: Array<{ signature: string; params?: unknown[] }>;
}): Generated {
  return {
    deployment: {
      chain_id: 1,
      safe_address: '0x3333333333333333333333333333333333333333',
      roles_modifier_address: '0x4444444444444444444444444444444444444444',
    },
    roles: {
      ROLE: {
        members: ['0x1111111111111111111111111111111111111111'],
        targets: [
          {
            address: target.address,
            functions: target.functions.map((f) => ({
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

describe('toSdkTargets', () => {
  it('TC-1: leaf-only path (equal_to + equal_to_avatar + oneOf) — regression', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      functions: [
        {
          signature: 'function supply(address asset, uint256 amount, address onBehalfOf)',
          params: [
            {
              name: 'asset',
              operator: 'oneOf',
              values: ['0xaaaa', '0xbbbb'],
              value_type: 'address',
            },
            { name: 'amount', operator: 'pass' },
            { name: 'onBehalfOf', operator: 'equal_to_avatar' },
          ],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{ condition?: unknown }>;
    expect(perms).toHaveLength(1);
    const cond = perms[0]!.condition as { kind: string; scoping: unknown[] };
    expect(cond.kind).toBe('calldataMatches');
    const sc = cond.scoping;
    // asset = oneOf(0xaaaa, 0xbbbb) → c.or(c.eq(...), c.eq(...))
    expect(sc[0]).toEqual({
      kind: 'or',
      branches: [
        { kind: 'eq', value: '0xaaaa' },
        { kind: 'eq', value: '0xbbbb' },
      ],
    });
    // amount = pass → undefined slot (top-level skip sentinel)
    expect(sc[1]).toBeUndefined();
    // onBehalfOf = equal_to_avatar → c.avatar
    expect(sc[2]).toEqual({ kind: 'avatar' });
  });

  it('TC-2: `or` of 2 leaves emits c.or(c.eq(a), c.eq(b))', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xpool',
      functions: [
        {
          signature: 'function pickToken(address token)',
          params: [
            {
              name: 'token',
              operator: 'or',
              conditions: [
                { operator: 'equal_to', value: '0xaaa', value_type: 'address' },
                { operator: 'equal_to', value: '0xbbb', value_type: 'address' },
              ],
            },
          ],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{ condition: { scoping: unknown[] } }>;
    expect(perms[0]!.condition.scoping[0]).toEqual({
      kind: 'or',
      branches: [
        { kind: 'eq', value: '0xaaa' },
        { kind: 'eq', value: '0xbbb' },
      ],
    });
  });

  it('TC-3: `or` of 1 leaf (degenerate) throws ZacError(phase=apply) "requires ≥ 2 conditions"', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xpool',
      functions: [
        {
          signature: 'function pickToken(address token)',
          params: [
            {
              name: 'token',
              operator: 'or',
              conditions: [{ operator: 'equal_to', value: '0xaaa', value_type: 'address' }],
            },
          ],
        },
      ],
    });
    try {
      toSdkTargets(gen, 'ROLE', r);
      throw new Error('expected toSdkTargets to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).phase).toBe('apply');
      expect((e as ZacError).message).toContain('requires ≥ 2 conditions');
      expect((e as ZacError).message).toContain('got 1');
    }
  });

  it('TC-4: `or` of 0 leaves throws same error path (got 0)', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xpool',
      functions: [
        {
          signature: 'function pickToken(address token)',
          params: [{ name: 'token', operator: 'or', conditions: [] }],
        },
      ],
    });
    try {
      toSdkTargets(gen, 'ROLE', r);
      throw new Error('expected toSdkTargets to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).message).toContain('requires ≥ 2 conditions');
      expect((e as ZacError).message).toContain('got 0');
    }
  });

  it('TC-5: `matches` over a 3-tuple emits c.matches with c.pass for pass-children', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xtarget',
      functions: [
        {
          signature: 'function f((address tokenA, uint256 amount, bool flag) order, uint256 nonce)',
          params: [
            {
              name: 'order',
              operator: 'matches',
              conditions: [
                { operator: 'equal_to', value: '0xaaa', value_type: 'address' },
                { operator: 'pass' },
                { operator: 'equal_to', value: true, value_type: 'bool' },
              ],
            },
            { name: 'nonce', operator: 'pass' },
          ],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{ condition: { scoping: unknown[] } }>;
    const matchesNode = perms[0]!.condition.scoping[0] as {
      kind: string;
      scoping: unknown[];
    };
    expect(matchesNode.kind).toBe('matches');
    expect(matchesNode.scoping).toEqual([
      { kind: 'eq', value: '0xaaa' },
      { kind: 'pass' },
      { kind: 'eq', value: true },
    ]);
  });

  it('TC-6: `matches` arity mismatch (2 conditions for 3-tuple) throws "arity mismatch"', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xtarget',
      functions: [
        {
          signature: 'function f((address a, uint256 b, bool c) order)',
          params: [
            {
              name: 'order',
              operator: 'matches',
              conditions: [
                { operator: 'equal_to', value: '0xaaa', value_type: 'address' },
                { operator: 'pass' },
              ],
            },
          ],
        },
      ],
    });
    try {
      toSdkTargets(gen, 'ROLE', r);
      throw new Error('expected toSdkTargets to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).message).toContain('arity mismatch');
      expect((e as ZacError).message).toContain('2 conditions vs 3 components');
    }
  });

  it('TC-7: `or` of `matches` (Morpho-Blue shape) — two markets, 5-component tuple each', () => {
    const r = recordingC();
    const market = (loan: string, coll: string) => ({
      operator: 'matches',
      conditions: [
        { operator: 'equal_to', value: loan, value_type: 'address' },
        { operator: 'equal_to', value: coll, value_type: 'address' },
        { operator: 'equal_to', value: '0xorac', value_type: 'address' },
        { operator: 'equal_to', value: '0xirm', value_type: 'address' },
        { operator: 'equal_to', value: '860000000000000000', value_type: 'uint256' },
      ],
    });
    const gen = makeGenerated({
      address: '0xmorpho',
      functions: [
        {
          signature:
            'function supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data)',
          params: [
            {
              name: 'marketParams',
              operator: 'or',
              conditions: [market('0xusdc', '0xweth'), market('0xusdc', '0xwbtc')],
            },
            { name: 'assets', operator: 'pass' },
            {
              name: 'shares',
              operator: 'equal_to',
              value: '0',
              value_type: 'uint256',
            },
            { name: 'onBehalf', operator: 'equal_to_avatar' },
            { name: 'data', operator: 'pass' },
          ],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{ condition: { scoping: unknown[] } }>;
    const orNode = perms[0]!.condition.scoping[0] as {
      kind: string;
      branches: Array<{ kind: string; scoping: unknown[] }>;
    };
    expect(orNode.kind).toBe('or');
    expect(orNode.branches).toHaveLength(2);
    expect(orNode.branches[0]!.kind).toBe('matches');
    expect(orNode.branches[0]!.scoping[0]).toEqual({ kind: 'eq', value: '0xusdc' });
    expect(orNode.branches[1]!.scoping[1]).toEqual({ kind: 'eq', value: '0xwbtc' });
  });

  it('TC-8: nested `matches` inside `matches` walks `components[i].components`', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xtarget',
      functions: [
        {
          signature: 'function f((address user, (address token, uint256 amount) inner) outer)',
          params: [
            {
              name: 'outer',
              operator: 'matches',
              conditions: [
                { operator: 'equal_to', value: '0xuser', value_type: 'address' },
                {
                  operator: 'matches',
                  conditions: [
                    { operator: 'equal_to', value: '0xtok', value_type: 'address' },
                    { operator: 'pass' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{ condition: { scoping: unknown[] } }>;
    const outer = perms[0]!.condition.scoping[0] as {
      kind: string;
      scoping: Array<unknown>;
    };
    expect(outer.kind).toBe('matches');
    const inner = outer.scoping[1] as { kind: string; scoping: unknown[] };
    expect(inner.kind).toBe('matches');
    expect(inner.scoping).toEqual([{ kind: 'eq', value: '0xtok' }, { kind: 'pass' }]);
  });

  it('TC-9: unsupported operator (`and`) still throws', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xtarget',
      functions: [
        {
          signature: 'function f(uint256 v)',
          params: [
            {
              name: 'v',
              operator: 'and',
              conditions: [
                { operator: 'greater_than', value: 1, value_type: 'uint256' },
                { operator: 'less_than', value: 100, value_type: 'uint256' },
              ],
            },
          ],
        },
      ],
    });
    try {
      toSdkTargets(gen, 'ROLE', r);
      throw new Error('expected toSdkTargets to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).message).toContain("unsupported operator 'and'");
    }
  });
});
