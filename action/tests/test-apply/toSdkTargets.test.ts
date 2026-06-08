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
      abiEncodedMatches: (scoping: unknown, abiTypes: readonly string[]) => ({
        kind: 'abiEncodedMatches',
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
  functions: Array<Record<string, unknown> & { signature: string }>;
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
            // Spread every function field through (signature, params, and the
            // root-`or` `operator`/`branches`) so test fixtures control them.
            functions: target.functions.map((f) => ({ execution_options: 'none', ...f })),
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

  it('TC-9: all-pass params block produces the same on-chain shape as omitting the params block', () => {
    // Optimization documented in toSdkTargets.ts buildPositionalScoping:
    // an all-pass params block is semantically equivalent to no scoping at
    // all (both produce a permission with no `condition` / calldataMatches).
    // Asserts the two YAML forms collapse to identical processPermissions input.
    const signature = 'function f(address a, uint256 b, bool c)';
    const address = '0xtarget';

    const rAllPass = recordingC();
    toSdkTargets(
      makeGenerated({
        address,
        functions: [
          {
            signature,
            params: [
              { name: 'a', operator: 'pass' },
              { name: 'b', operator: 'pass' },
              { name: 'c', operator: 'pass' },
            ],
          },
        ],
      }),
      'ROLE',
      rAllPass,
    );

    const rOmitted = recordingC();
    toSdkTargets(makeGenerated({ address, functions: [{ signature }] }), 'ROLE', rOmitted);

    const allPassPerms = rAllPass.getProcessPermissionsArg() as Array<Record<string, unknown>>;
    const omittedPerms = rOmitted.getProcessPermissionsArg() as Array<Record<string, unknown>>;

    // Same permission shape — and neither carries a `condition` field, so the
    // function is allowed unconditionally on-chain.
    expect(allPassPerms).toEqual(omittedPerms);
    expect(allPassPerms).toHaveLength(1);
    expect(allPassPerms[0]).toEqual({ targetAddress: address, signature });
    expect(allPassPerms[0]).not.toHaveProperty('condition');
  });

  it('TC-11: `param_type: abi_encoded` emits c.abiEncodedMatches over the declared children', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xmilkman',
      functions: [
        {
          signature:
            'function requestSwap(address fromToken, address priceChecker, bytes priceCheckerData)',
          params: [
            { name: 'fromToken', operator: 'equal_to', value: '0xusdc', value_type: 'address' },
            {
              name: 'priceChecker',
              operator: 'equal_to',
              value: '0xchecker',
              value_type: 'address',
            },
            {
              name: 'priceCheckerData',
              param_type: 'abi_encoded',
              children: [
                {
                  name: 'slippageBps',
                  param_type: 'static',
                  operator: 'less_than',
                  value: '501',
                  value_type: 'uint256',
                },
                { name: 'innerData', param_type: 'dynamic', operator: 'pass' },
              ],
            },
          ],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{ condition: { scoping: unknown[] } }>;
    const sc = perms[0]!.condition.scoping;
    expect(sc[2]).toEqual({
      kind: 'abiEncodedMatches',
      scoping: [{ kind: 'lt', value: '501' }, { kind: 'pass' }],
      abiTypes: ['uint256', 'bytes'],
    });
  });

  it('TC-12: function-root `or` of branches emits c.or(calldataMatches, calldataMatches)', () => {
    const r = recordingC();
    const branch = (to: string, cap: string) => ({
      operator: 'matches',
      params: [
        { name: 'fromToken', operator: 'equal_to', value: '0xusdc', value_type: 'address' },
        { name: 'toToken', operator: 'equal_to', value: to, value_type: 'address' },
        {
          name: 'priceCheckerData',
          param_type: 'abi_encoded',
          children: [
            {
              name: 'slippageBps',
              param_type: 'static',
              operator: 'less_than',
              value: cap,
              value_type: 'uint256',
            },
            { name: 'innerData', param_type: 'dynamic', operator: 'pass' },
          ],
        },
      ],
    });
    const gen = makeGenerated({
      address: '0xmilkman',
      functions: [
        {
          signature:
            'function requestSwap(address fromToken, address toToken, bytes priceCheckerData)',
          operator: 'or',
          branches: [branch('0xpyusd', '501'), branch('0xrlusd', '701')],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{
      condition: { kind: string; branches: Array<{ kind: string; scoping: unknown[] }> };
    }>;
    const root = perms[0]!.condition;
    expect(root.kind).toBe('or');
    expect(root.branches).toHaveLength(2);
    expect(root.branches[0]!.kind).toBe('calldataMatches');
    // branch 0: toToken == 0xpyusd, slippage < 501
    expect(root.branches[0]!.scoping[1]).toEqual({ kind: 'eq', value: '0xpyusd' });
    expect(root.branches[1]!.scoping[1]).toEqual({ kind: 'eq', value: '0xrlusd' });
    const abiEnc0 = root.branches[0]!.scoping[2] as { scoping: unknown[] };
    expect(abiEnc0.scoping[0]).toEqual({ kind: 'lt', value: '501' });
  });

  it('TC-13: `abi_encoded` with no children throws ZacError(phase=apply)', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xmilkman',
      functions: [
        {
          signature: 'function f(bytes data)',
          params: [{ name: 'data', param_type: 'abi_encoded', children: [] }],
        },
      ],
    });
    try {
      toSdkTargets(gen, 'ROLE', r);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).message).toContain('requires ≥ 1 child');
    }
  });

  it('TC-14: function-root `or` with a single branch collapses to a plain calldataMatches', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xmilkman',
      functions: [
        {
          signature: 'function f(address a)',
          operator: 'or',
          branches: [
            { params: [{ name: 'a', operator: 'equal_to', value: '0x1', value_type: 'address' }] },
          ],
        },
      ],
    });
    toSdkTargets(gen, 'ROLE', r);
    const perms = r.getProcessPermissionsArg() as Array<{
      condition: { kind: string; scoping: unknown[] };
    }>;
    const root = perms[0]!.condition;
    // No `or` wrapper — the lone branch is the condition.
    expect(root.kind).toBe('calldataMatches');
    expect(root.scoping[0]).toEqual({ kind: 'eq', value: '0x1' });
  });

  it('TC-15: function-root `or` with 0 branches throws', () => {
    const r = recordingC();
    const gen = makeGenerated({
      address: '0xmilkman',
      functions: [{ signature: 'function f(address a)', operator: 'or', branches: [] }],
    });
    try {
      toSdkTargets(gen, 'ROLE', r);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).message).toContain('requires ≥ 1 branch');
    }
  });

  it('TC-10: unsupported operator (`and`) still throws', () => {
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
