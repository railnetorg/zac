import { describe, it, expect } from 'vitest';
import { planSafeConfig } from '../../apply/planSafeConfig';
import type { SafeLike, SafeTransactionLike } from '../../apply/safeApi';
import type { ParsedSafeYaml } from '../../validate/safeConfigSchema';
import { ZacError } from '../../errors';

const SAFE = '0x40FF9A84a5Da941A060E2925DA228aab328DDe58';
const GUARD_A = '0x1111111111111111111111111111111111111111';
const GUARD_B = '0x2222222222222222222222222222222222222222';
const FALLBACK_A = '0x3333333333333333333333333333333333333333';
const FALLBACK_B = '0x4444444444444444444444444444444444444444';
const MOD_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MOD_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MOD_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Build a `SafeLike` stub. Each method records its call args so the test
 * can assert call ORDER and ARGS. Live state is configured via `state`.
 * Tx-builders return a deterministic `data` payload tagged with the kind
 * and address so the test can assert the generated `Call[]`.
 */
function buildSafeStub(state: { guard?: string; fallback?: string; modules?: string[] }): SafeLike {
  function txFor(kind: string, addr: string): SafeTransactionLike {
    return {
      data: {
        to: SAFE,
        value: '0',
        data: `0x${kind}:${addr.toLowerCase()}` as `0x${string}` as string,
        operation: 0,
      },
    };
  }
  function txForNoArg(kind: string): SafeTransactionLike {
    return {
      data: {
        to: SAFE,
        value: '0',
        // Distinct `kind` tag (e.g. `disableFallback`) so assertions can
        // distinguish a no-arg "clear" call from a same-selector enable call
        // that happened to pass the zero address (paranoid regression guard).
        data: `0x${kind}` as `0x${string}` as string,
        operation: 0,
      },
    };
  }
  return {
    createTransaction: async () => ({
      data: { to: SAFE, value: '0', data: '0xstub', operation: 0 },
    }),
    getTransactionHash: async () => '0xunused',
    signHash: async () => ({ data: '0xsig' }),
    getGuard: async () => state.guard ?? ZERO,
    getFallbackHandler: async () => state.fallback ?? ZERO,
    getModules: async () => state.modules ?? [],
    createEnableGuardTx: async (a: string) => txFor('setGuard', a),
    createDisableGuardTx: async () => txForNoArg('disableGuard'),
    createEnableFallbackHandlerTx: async (a: string) => txFor('setFallback', a),
    createDisableFallbackHandlerTx: async () => txForNoArg('disableFallback'),
    createEnableModuleTx: async (a: string) => txFor('enableModule', a),
    createDisableModuleTx: async (a: string) => txFor('disableModule', a),
  };
}

type GuardInput = string | { address: string; timelockDelay?: number } | null;

/** Build a `ParsedSafeYaml` allowing the convenient bare-string `guard:` form. */
function yaml(
  over: { guard?: GuardInput; fallback?: string | null; modules?: string[] | null } = {},
): ParsedSafeYaml {
  const out: ParsedSafeYaml = { guard: null, fallback: null, modules: null };
  if (over.guard !== undefined) {
    out.guard =
      over.guard === null
        ? null
        : typeof over.guard === 'string'
          ? { address: over.guard }
          : over.guard;
  }
  if (over.fallback !== undefined) out.fallback = over.fallback;
  if (over.modules !== undefined) out.modules = over.modules;
  return out;
}

describe('planSafeConfig', () => {
  it('all-~ → empty Call[]', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({}),
      safe: buildSafeStub({}),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toEqual([]);
  });

  // ── guard semantics ───────────────────────────────────────────────────
  //
  // Symmetric to `fallback`: zero address is an EXPLICIT clear (emits
  // setGuard(0x0)); only `~` (null) skips the slot. The inequality guard
  // (`liveGuard !== desiredGuard`) short-circuits when desired=0x0 and
  // live is already 0x0 (the "in-sync" path), avoiding protocol-kit's
  // "There is no guard enabled yet" throw.

  it('guard matches live (case-insensitive) → no setGuard call', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: GUARD_A.toLowerCase() }),
      safe: buildSafeStub({ guard: GUARD_A.toUpperCase().replace('X', 'x') }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toEqual([]);
  });

  it('guard differs from live → one setGuard call carrying the desired addr', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: GUARD_A }),
      safe: buildSafeStub({ guard: GUARD_B }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(SAFE);
    expect(calls[0]!.value).toBe('0');
    expect(calls[0]!.data).toContain('setGuard');
    expect(calls[0]!.data.toLowerCase()).toContain(GUARD_A.toLowerCase());
  });

  it('guard: 0x0 with live non-zero → emits the no-arg disable builder (NOT the enable builder with zero arg)', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: ZERO }),
      safe: buildSafeStub({ guard: GUARD_A }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toHaveLength(1);
    // Stub tags the no-arg builder with `disableGuard` (vs `setGuard`
    // for the enable builder) — a regression that wired the zero arg
    // through `createEnableGuardTx(ZERO)` would carry the `setGuard`
    // tag instead and this assertion would fail.
    expect(calls[0]!.data).toContain('disableGuard');
    expect(calls[0]!.data.toLowerCase()).not.toContain(GUARD_A.toLowerCase());
  });

  it('guard: 0x0 with live already zero → no-op (inequality guard short-circuits)', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: ZERO }),
      safe: buildSafeStub({ guard: ZERO }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toEqual([]);
  });

  it('guard: ~ → no-op regardless of live state (both non-zero and zero)', async () => {
    const a = await planSafeConfig({
      safeYaml: yaml({ guard: null }),
      safe: buildSafeStub({ guard: GUARD_A }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(a).toEqual([]);
    const b = await planSafeConfig({
      safeYaml: yaml({ guard: null }),
      safe: buildSafeStub({ guard: ZERO }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(b).toEqual([]);
  });

  it('guard: 0x0 with live non-zero but SafeLike missing createDisableGuardTx → ZacError(apply, "internal: ...")', async () => {
    const partial: SafeLike = {
      createTransaction: async () => ({
        data: { to: SAFE, value: '0', data: '0x', operation: 0 },
      }),
      getTransactionHash: async () => '0x',
      signHash: async () => ({ data: '0x' }),
      getGuard: async () => GUARD_A,
      getFallbackHandler: async () => ZERO,
      getModules: async () => [],
      // createDisableGuardTx intentionally missing
    };
    await expect(
      planSafeConfig({
        safeYaml: yaml({ guard: ZERO }),
        safe: partial,
        safeAddress: SAFE,
        declaredModifiers: [],
      }),
    ).rejects.toThrow(/internal: Safe instance missing createDisableGuardTx/);
  });

  // ── fallback semantics ────────────────────────────────────────────────
  //
  // Symmetric to `guard`: zero address is an EXPLICIT clear (emits
  // setFallbackHandler(0x0)); only `~` (null) skips the slot. See the
  // guard block above and `ParsedSafeYaml` JSDoc in
  // `validate/safeConfigSchema.ts`.

  it('fallback differs → one setFallbackHandler call carrying the desired addr', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ fallback: FALLBACK_A }),
      safe: buildSafeStub({ fallback: FALLBACK_B }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toContain('setFallback');
    // Asserts the DESIRED address rides in calldata (catches an
    // enable/disable mix-up that drops the addr).
    expect(calls[0]!.data.toLowerCase()).toContain(FALLBACK_A.toLowerCase());
  });

  it('fallback: 0x0 with live non-zero → emits the no-arg disable builder (NOT the enable builder with zero arg)', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ fallback: ZERO }),
      safe: buildSafeStub({ fallback: FALLBACK_A }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toHaveLength(1);
    // Stub tags the no-arg builder with `disableFallback` (vs `setFallback`
    // for the enable builder) — a regression that wired the zero arg
    // through `createEnableFallbackHandlerTx(ZERO)` would carry the
    // `setFallback` tag instead and this assertion would fail.
    expect(calls[0]!.data).toContain('disableFallback');
    // Negative paranoia: must not echo the LIVE fallback addr (catches a
    // branch that mistakenly forwards `liveFallback` to the disable builder).
    expect(calls[0]!.data.toLowerCase()).not.toContain(FALLBACK_A.toLowerCase());
  });

  it('fallback: 0x0 with live already zero → no-op (inequality guard short-circuits)', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ fallback: ZERO }),
      safe: buildSafeStub({ fallback: ZERO }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toEqual([]);
  });

  it('fallback: ~ → no-op regardless of live state (both non-zero and zero)', async () => {
    // Non-zero live: zac must NOT manage this slot.
    const a = await planSafeConfig({
      safeYaml: yaml({ fallback: null }),
      safe: buildSafeStub({ fallback: FALLBACK_A }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(a).toEqual([]);
    // Zero live: same — the whole fallback block is gated by `fallback !== null`.
    const b = await planSafeConfig({
      safeYaml: yaml({ fallback: null }),
      safe: buildSafeStub({ fallback: ZERO }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(b).toEqual([]);
  });

  it('fallback: 0x0 with live non-zero but SafeLike missing createDisableFallbackHandlerTx → ZacError(apply, "internal: ...")', async () => {
    const partial: SafeLike = {
      createTransaction: async () => ({
        data: { to: SAFE, value: '0', data: '0x', operation: 0 },
      }),
      getTransactionHash: async () => '0x',
      signHash: async () => ({ data: '0x' }),
      getGuard: async () => ZERO,
      getFallbackHandler: async () => FALLBACK_A,
      getModules: async () => [],
      // createDisableFallbackHandlerTx intentionally missing
    };
    await expect(
      planSafeConfig({
        safeYaml: yaml({ fallback: ZERO }),
        safe: partial,
        safeAddress: SAFE,
        declaredModifiers: [],
      }),
    ).rejects.toThrow(/internal: Safe instance missing createDisableFallbackHandlerTx/);
  });

  it('modules: ~ → no module reconcile', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ modules: null }),
      safe: buildSafeStub({ modules: [MOD_A] }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toEqual([]);
  });

  it('modules: [A,B] vs live: [B,C] → disable C, enable A (set-diff)', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ modules: [MOD_A, MOD_B] }),
      safe: buildSafeStub({ modules: [MOD_B, MOD_C] }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    const datas = calls.map((c) => c.data);
    expect(datas.some((d) => d.includes('disableModule') && d.includes(MOD_C))).toBe(true);
    expect(datas.some((d) => d.includes('enableModule') && d.includes(MOD_A))).toBe(true);
    // No spurious calls for MOD_B (in both desired and live).
    expect(datas.some((d) => d.includes(MOD_B))).toBe(false);
  });

  it('modules: [0x0, A] vs live: [A] → zero filtered, no diff, empty calls', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ modules: [ZERO, MOD_A] }),
      safe: buildSafeStub({ modules: [MOD_A] }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toEqual([]);
  });

  it('cross-validation success: declared modifier in filtered list', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ modules: [MOD_A] }),
      safe: buildSafeStub({ modules: [MOD_A] }),
      safeAddress: SAFE,
      declaredModifiers: [{ address: MOD_A, sourceFile: '/a/b.zac.yaml' }],
    });
    expect(calls).toEqual([]);
  });

  it('cross-validation failure: missing modifier → ZacError names the sourceFile', async () => {
    await expect(
      planSafeConfig({
        safeYaml: yaml({ modules: [MOD_B] }),
        safe: buildSafeStub({ modules: [] }),
        safeAddress: SAFE,
        declaredModifiers: [{ address: MOD_A, sourceFile: '/path/to/a.zac.yaml' }],
      }),
    ).rejects.toThrow(ZacError);
    try {
      await planSafeConfig({
        safeYaml: yaml({ modules: [MOD_B] }),
        safe: buildSafeStub({ modules: [] }),
        safeAddress: SAFE,
        declaredModifiers: [{ address: MOD_A, sourceFile: '/path/to/a.zac.yaml' }],
      });
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('/path/to/a.zac.yaml');
      expect((e as ZacError).message).toContain('does not include the roles modifier');
    }
  });

  it('address-case mismatch: EIP-55 vs lowercase compared case-insensitively', async () => {
    // safe.yaml has checksummed (mixed-case-looking via uppercase fragments),
    // declared modifier is lowercased. No false-positive error.
    const checksummish = `0x${MOD_A.slice(2).toUpperCase()}`;
    const calls = await planSafeConfig({
      safeYaml: yaml({ modules: [checksummish] }),
      safe: buildSafeStub({ modules: [checksummish] }),
      safeAddress: SAFE,
      declaredModifiers: [{ address: MOD_A, sourceFile: '/a.zac.yaml' }],
    });
    expect(calls).toEqual([]);
  });

  it('ordering invariant: all 4 ops together → [disables, enables, setGuard, setFallback]', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({
        guard: GUARD_A,
        fallback: FALLBACK_A,
        modules: [MOD_A], // enable A
      }),
      safe: buildSafeStub({
        guard: GUARD_B, // changing
        fallback: FALLBACK_B, // changing
        modules: [MOD_C], // disable C, enable A
      }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]!.data).toContain('disableModule');
    expect(calls[1]!.data).toContain('enableModule');
    expect(calls[2]!.data).toContain('setGuard');
    expect(calls[3]!.data).toContain('setFallback');
  });

  it('every emitted Call has to === safeAddress and value === "0" (operation field dropped)', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: GUARD_A, fallback: FALLBACK_A, modules: [MOD_A] }),
      safe: buildSafeStub({ guard: ZERO, fallback: ZERO, modules: [] }),
      safeAddress: SAFE,
      declaredModifiers: [],
    });
    for (const c of calls) {
      expect(c.to).toBe(SAFE);
      expect(c.value).toBe('0');
      // `operation` is not part of the Call shape — destructured out.
      expect(c).not.toHaveProperty('operation');
    }
  });

  it('guard with timelockDelay, guard differs from live, live delay differs → setGuard + configureTimelockGuard', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: { address: GUARD_A, timelockDelay: 86400 } }),
      safe: buildSafeStub({ guard: GUARD_B }),
      safeAddress: SAFE,
      declaredModifiers: [],
      readTimelockDelay: async () => 0n,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.data).toContain('setGuard');
    // configureTimelockGuard call targets the guard contract directly.
    expect(calls[1]!.to.toLowerCase()).toBe(GUARD_A.toLowerCase());
    expect(calls[1]!.value).toBe('0');
    // Selector for `configureTimelockGuard(uint256)`.
    expect(calls[1]!.data.startsWith('0x')).toBe(true);
    // 86400 = 0x15180 — encoded as 32-byte arg padded.
    expect(calls[1]!.data.toLowerCase()).toContain('15180');
  });

  it('guard with timelockDelay, guard matches live, delay matches live → no calls', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: { address: GUARD_A, timelockDelay: 86400 } }),
      safe: buildSafeStub({ guard: GUARD_A }),
      safeAddress: SAFE,
      declaredModifiers: [],
      readTimelockDelay: async () => 86400n,
    });
    expect(calls).toEqual([]);
  });

  it('guard with timelockDelay, guard matches live, delay differs → only configureTimelockGuard', async () => {
    const calls = await planSafeConfig({
      safeYaml: yaml({ guard: { address: GUARD_A, timelockDelay: 86400 } }),
      safe: buildSafeStub({ guard: GUARD_A }),
      safeAddress: SAFE,
      declaredModifiers: [],
      readTimelockDelay: async () => 3600n,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to.toLowerCase()).toBe(GUARD_A.toLowerCase());
  });

  it('guard with timelockDelay but no readTimelockDelay provided → ZacError(apply)', async () => {
    await expect(
      planSafeConfig({
        safeYaml: yaml({ guard: { address: GUARD_A, timelockDelay: 86400 } }),
        safe: buildSafeStub({ guard: GUARD_B }),
        safeAddress: SAFE,
        declaredModifiers: [],
      }),
    ).rejects.toThrow(/readTimelockDelay is required/);
  });

  it('SafeLike missing `getGuard` → ZacError(apply, "internal: ...")', async () => {
    const partial: SafeLike = {
      createTransaction: async () => ({
        data: { to: SAFE, value: '0', data: '0x', operation: 0 },
      }),
      getTransactionHash: async () => '0x',
      signHash: async () => ({ data: '0x' }),
      // getGuard intentionally missing
      getFallbackHandler: async () => ZERO,
      getModules: async () => [],
    };
    await expect(
      planSafeConfig({
        safeYaml: yaml({ guard: GUARD_A }),
        safe: partial,
        safeAddress: SAFE,
        declaredModifiers: [],
      }),
    ).rejects.toThrow(/internal: Safe instance missing getGuard/);
  });
});
