import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { printPlanDiff } from '../../apply/printPlanDiff';
import type { DecodeSdk } from '../../apply/decodeCall';
import type { Plan, PlanCall } from '../../apply/planSchema';

/** Same calldata fixtures as `decodeCall.test.ts`. */
const MODIFIER = '0x6a2A4eb8695e501AFD6599020FAB970D6018012a';

const FIX_ASSIGN_ROLES_ETHENA: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x957ed2b30000000000000000000000004ecb4c676e596a5b2b9084c5aec8fce058ce71a6000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000001455448454e415f494e535449545554494f4e414c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000',
};

const FIX_REVOKE_TARGET_ETHENA: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x0172a43a455448454e415f494e535449545554494f4e414c0000000000000000000000000000000000000000000000004c9edd5852cd905f086c759e8383e09bff1e68b3',
};

const FIX_REVOKE_FUNCTION_ETHENA_APPROVE: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x66523f7d455448454e415f494e535449545554494f4e414c0000000000000000000000000000000000000000000000004c9edd5852cd905f086c759e8383e09bff1e68b3095ea7b300000000000000000000000000000000000000000000000000000000',
};

const FIX_REVOKE_TARGET_LAGOON: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x0172a43a4c41474f4f4e000000000000000000000000000000000000000000000000000000000000000000000000000030a3699e0dcea6bdc8bb2c13e74a2324e0b20116',
};

const FIX_REVOKE_FUNCTION_LAGOON_927B15DF: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x66523f7d4c41474f4f4e000000000000000000000000000000000000000000000000000000000000000000000000000030a3699e0dcea6bdc8bb2c13e74a2324e0b20116927b15df00000000000000000000000000000000000000000000000000000000',
};

const FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B: PlanCall = {
  to: MODIFIER,
  value: '0',
  // We can use a SHORT bogus calldata: viem rejects mid-decode if the
  // dynamic-array offsets don't add up, so we need a real one. Reuse the
  // header from the long fixture but only need the selector + roleKey +
  // target + fnSelector slots — viem will still try to decode the rest
  // and throw, falling back to unknown. To keep this test focused on
  // scopeFunction we use a small synthesized payload below.
  data: '0x7508dd984f4e444f5f474d000000000000000000000000000000000000000000000000000000000000000000000000002c158bc456e027b2affccadf1bdbd9f5fc4c5c8c445df08b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
};

// Fixture from the all-pass repro plan. SDK emits `allowFunction`
// (selector `0xb3dd25c7`) for functions with no calldata condition —
// the optimization in `buildPositionalScoping` (`if (allPass) return null`)
// that maps "all params are pass" to "no scoping at all" on-chain. Role
// `ALL_PASS`, target USDC, selector `0x1bca4f52` = `tag(bytes32,uint256)`.
const FIX_ALLOW_FUNCTION_ALL_PASS_TAG: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0xb3dd25c7414c4c5f50415353000000000000000000000000000000000000000000000000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb481bca4f52000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
};

const FIX_UNKNOWN: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0xdeadbeef',
};

async function loadSdk(): Promise<DecodeSdk> {
  const mod = (await import('zodiac-roles-sdk')) as unknown as DecodeSdk;
  return { decodeKey: mod.decodeKey, rolesAbi: mod.rolesAbi };
}

function captureSink(): { sink: NodeJS.WritableStream; text: () => string } {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  return { sink, text: () => Buffer.concat(chunks).toString('utf8') };
}

/** Build a minimal Plan around an array of calls. */
function makePlan(calls: PlanCall[]): Plan {
  return {
    calls,
    callsCount: calls.length,
    chainId: 1,
    modifierAddress: MODIFIER,
    safeAddress: '0x40FF9A84a5Da941A060E2925DA228aab328DDe58',
  };
}

describe('printPlanDiff', () => {
  it('plan with only revokes → "revokes (N)" tree section + no "adds" + no unmentioned annotation when declaredRoleKeys is undefined', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_ETHENA, FIX_REVOKE_FUNCTION_ETHENA_APPROVE]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'configs/m/safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
    });
    const out = text();
    expect(out).toContain('plan: configs/m/safe.plan.json (2 calls)');
    // Tree section header (└─ because revokes is the only section).
    expect(out).toMatch(/[├└]─ revokes \(2\)/);
    expect(out).not.toContain('adds (');
    expect(out).not.toContain('not declared in any source');
    expect(out).toContain('ETHENA_INSTITUTIONAL');
    // Call lines render as `<kind>(<target>, <fn-or-selector>)`.
    expect(out).toMatch(/revokeTarget\(/);
    expect(out).toMatch(/revokeFunction\(.*approve\)/);
  });

  it('plan with revokes + declaredRoleKeys covering some → role-key gets inline `⚠ not declared in any source` annotation', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([
      FIX_REVOKE_TARGET_ETHENA,
      FIX_REVOKE_TARGET_LAGOON,
      FIX_REVOKE_FUNCTION_LAGOON_927B15DF,
    ]);
    const { sink, text } = captureSink();
    // Declare only LAGOON; ETHENA_INSTITUTIONAL is unmentioned.
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      declaredRoleKeys: new Set(['LAGOON']),
      out: sink,
      sdk,
    });
    const out = text();
    // ETHENA_INSTITUTIONAL flagged inline; LAGOON not.
    expect(out).toContain('ETHENA_INSTITUTIONAL  ⚠ not declared in any source');
    expect(out).not.toMatch(/LAGOON\s+⚠/);
  });

  it('plan with revokes only of declared roles → no unmentioned annotation', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      declaredRoleKeys: new Set(['LAGOON', 'ETHENA_INSTITUTIONAL']),
      out: sink,
      sdk,
    });
    expect(text()).not.toContain('not declared in any source');
  });

  it('plan with only scopeFunction → "adds (N)" tree section + no "revokes"; call leaf renders raw selector when no fn-name map', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
    });
    const out = text();
    expect(out).toMatch(/[├└]─ adds \(1\)/);
    expect(out).not.toContain('revokes (');
    expect(out).toContain('ONDO_GM');
    // Raw selector in the leaf (no selectorMap provided, no built-in entry).
    expect(out).toMatch(/scopeFunction\(.*, 0x445df08b\)/);
  });

  it('plan with only allowFunction → grouped under its role like scopeFunction (regression: previously rendered as `unknown`)', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_ALLOW_FUNCTION_ALL_PASS_TAG]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      selectorMap: { '0x1bca4f52': 'tag' },
    });
    const out = text();
    expect(out).toMatch(/[├└]─ adds \(1\)/);
    expect(out).not.toContain('revokes (');
    // Grouped under its role key — not punted to the `unknown` bucket.
    expect(out).toContain('ALL_PASS');
    // fn-name from selectorMap shows up in place of the raw selector.
    expect(out).toMatch(/allowFunction\(.*, tag\)/);
    // `unknown` section absent entirely.
    expect(out).not.toMatch(/unknown\(selector=0xb3dd25c7/);
  });

  it('plan with assignRoles (all true) → appears in "adds" section under an `assignRoles` group', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_ASSIGN_ROLES_ETHENA]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
    });
    const out = text();
    expect(out).toMatch(/[├└]─ adds \(1\)/);
    expect(out).toContain('assignRoles');
    expect(out).toContain('roles=[ETHENA_INSTITUTIONAL]');
    expect(out).toContain('assigned=[false]');
  });

  it('plan with unknown selector → grouped under `unknown` in adds; raw selector + dataLen shown', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_UNKNOWN]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
    });
    const out = text();
    expect(out).toMatch(/[├└]─ adds \(1\)/);
    expect(out).toMatch(/unknown\(selector=0xdeadbeef, dataLen=\d+\)/);
  });

  it('plan that mixes revokes + adds + unmentioned annotation → both sections present, revokes before adds, annotation inline', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([
      FIX_REVOKE_TARGET_ETHENA,
      FIX_REVOKE_FUNCTION_ETHENA_APPROVE,
      FIX_REVOKE_TARGET_LAGOON,
      FIX_REVOKE_FUNCTION_LAGOON_927B15DF,
      FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B,
      FIX_ASSIGN_ROLES_ETHENA,
    ]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      declaredRoleKeys: new Set(['ONDO_GM']),
      out: sink,
      sdk,
    });
    const out = text();
    const idxRevokes = out.search(/[├└]─ revokes \(/);
    const idxAdds = out.search(/[├└]─ adds \(/);
    expect(idxRevokes).toBeGreaterThan(-1);
    expect(idxAdds).toBeGreaterThan(-1);
    expect(idxRevokes).toBeLessThan(idxAdds);
    // Both unmentioned role keys flagged inline (ONDO_GM is declared, not flagged).
    expect(out).toContain('ETHENA_INSTITUTIONAL  ⚠ not declared in any source');
    expect(out).toContain('LAGOON  ⚠ not declared in any source');
    expect(out).not.toMatch(/ONDO_GM\s+⚠/);
  });

  it('addressLabelMap: known target address renders as `<short> (<label>)`; unknown stays bare', async () => {
    const sdk = await loadSdk();
    // Lagoon target `0x30A3699E0DCea6Bdc8BB2c13E74A2324e0B20116` is mapped
    // to `lagoon.vault`; the Ondo GM target is left unmapped so we can
    // assert the unknown path stays untouched in the same plan.
    const labelMap = {
      '0x30a3699e0dcea6bdc8bb2c13e74a2324e0b20116': 'lagoon.vault',
    };
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON, FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      addressLabelMap: labelMap,
    });
    const out = text();
    expect(out).toMatch(/revokeTarget\(0x30[Aa]3…0116 \(lagoon\.vault\)\)/);
    // Unmapped target stays bare — no spurious parenthetical suffix.
    expect(out).toMatch(/scopeFunction\(0x2[Cc]15…5[Cc]8[Cc], /);
    expect(out).not.toMatch(/scopeFunction\(0x2[Cc]15…5[Cc]8[Cc] \(/);
  });

  it('addressLabelMap: function-permission lines also annotate the target inside the call header', async () => {
    const sdk = await loadSdk();
    const labelMap = { '0x2c158bc456e027b2affccadf1bdbd9f5fc4c5c8c': 'ondo_gm.manager' };
    const plan = makePlan([FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      addressLabelMap: labelMap,
    });
    const out = text();
    // Single tree line carrying both target-label and the selector/fn-name.
    expect(out).toMatch(/scopeFunction\(0x2[Cc]15…5[Cc]8[Cc] \(ondo_gm\.manager\), 0x445df08b\)/);
  });

  it('addressLabelMap lookup is case-insensitive against checksummed addresses (map is lowercase, plan addresses are checksummed)', async () => {
    const sdk = await loadSdk();
    const labelMap = { '0x30a3699e0dcea6bdc8bb2c13e74a2324e0b20116': 'lagoon.vault' };
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      addressLabelMap: labelMap,
    });
    expect(text()).toContain('(lagoon.vault)');
  });

  it('functionParamMap: scopeFunction call expands into a param-subtree with column-aligned <type> <name> constraint lines', async () => {
    const sdk = await loadSdk();
    // ONDO_GM scopeFunction fixture targets 0x2c15…5C8C with selector
    // 0x445df08b. Wire up a source-side entry simulating what
    // buildFunctionParamMap would have produced from the generated YAML.
    const paramMap = {
      // Role-keyed: the fixture decodes to roleKey ONDO_GM (target 0x2c15…5C8C,
      // selector 0x445df08b).
      'ONDO_GM:0x2c158bc456e027b2affccadf1bdbd9f5fc4c5c8c:0x445df08b': {
        signature: 'function subscribe(address asset, uint256 amount, address receiver)',
        fnName: 'subscribe',
        inputs: [
          { type: 'address', name: 'asset' },
          { type: 'uint256', name: 'amount' },
          { type: 'address', name: 'receiver' },
        ],
        params: [
          {
            name: 'asset',
            operator: 'equal_to',
            value: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            value_type: 'address',
          },
          { name: 'amount', operator: 'pass' },
          { name: 'receiver', operator: 'equal_to_avatar' },
        ],
      },
    };
    const labelMap = { '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'tokens.USDC' };
    const plan = makePlan([FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      functionParamMap: paramMap,
      addressLabelMap: labelMap,
    });
    const out = text();
    // Call header carries the function name from the map.
    expect(out).toMatch(/scopeFunction\(0x2[Cc]15…5[Cc]8[Cc], subscribe\)/);
    // Three param leaves under the call, in declared order.
    expect(out).toMatch(/├─ address asset\s+= 0xA0b8…eB48 \(tokens\.USDC\)/);
    expect(out).toMatch(/├─ uint256 amount\s+\*/);
    expect(out).toMatch(/└─ address receiver\s+= <avatar>/);
  });

  it('functionParamMap: a colliding (target, selector) entry from ANOTHER role is NOT used — lookup is role-keyed', async () => {
    const sdk = await loadSdk();
    // The fixture decodes to roleKey ONDO_GM. Provide a DECOY entry under a
    // different role (AAVE_V3) for the SAME target:selector — pre-fix the
    // target:selector-only key collided and the decoy could shadow the real
    // one (the actual "every approve shows aave.pool" bug). The renderer must
    // pick the ONDO_GM entry by role.
    const target = '0x2c158bc456e027b2affccadf1bdbd9f5fc4c5c8c';
    const realEntry = {
      signature: 'function subscribe(address asset, uint256 amount, address receiver)',
      fnName: 'subscribe',
      inputs: [
        { type: 'address', name: 'asset' },
        { type: 'uint256', name: 'amount' },
        { type: 'address', name: 'receiver' },
      ],
      params: [
        { name: 'asset', operator: 'equal_to', value: target, value_type: 'address' },
        { name: 'amount', operator: 'pass' },
        { name: 'receiver', operator: 'equal_to_avatar' },
      ],
    };
    const decoyEntry = {
      signature: 'function decoyFn(address shouldNotRender)',
      fnName: 'decoyFn',
      inputs: [{ type: 'address', name: 'shouldNotRender' }],
      params: [{ name: 'shouldNotRender', operator: 'pass' }],
    };
    const paramMap = {
      [`ONDO_GM:${target}:0x445df08b`]: realEntry,
      [`AAVE_V3:${target}:0x445df08b`]: decoyEntry,
    };
    const plan = makePlan([FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      functionParamMap: paramMap,
    });
    const out = text();
    expect(out).toContain('subscribe'); // the ONDO_GM entry was used
    expect(out).not.toContain('decoyFn'); // the AAVE_V3 collision did NOT leak
    expect(out).not.toContain('shouldNotRender');
  });

  it('functionParamMap: scopeFunction with no matching entry falls back to leaf rendering (no param subtree)', async () => {
    const sdk = await loadSdk();
    // Empty paramMap — same fixture, but no source-side entry to expand into.
    const plan = makePlan([FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      functionParamMap: {},
    });
    const out = text();
    // No tree children under the scopeFunction line — verified by checking
    // the next non-empty line after `scopeFunction(...)` doesn't start with
    // a `├─`/`└─` connector at deeper indent.
    const lines = out.trimEnd().split('\n');
    const scopeIdx = lines.findIndex((l) => l.includes('scopeFunction('));
    expect(scopeIdx).toBeGreaterThan(-1);
    // Either the scopeFunction line is the last call line, or what follows
    // continues the same indent depth — no descent into a param subtree.
    const next = lines[scopeIdx + 1];
    if (next !== undefined) {
      // A child of scopeFunction would start with at least one more 4-char
      // indent level than the scopeFunction connector itself.
      expect(next).not.toMatch(/^\s{8,}[├└]─ \w+ \w+\s+[=*]/);
    }
  });

  it('shortens addresses to first4…last4 format inside call headers', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
    });
    const out = text();
    // 0x30A3699E0DCea6Bdc8BB2c13E74A2324e0B20116 → 0x30A3…0116
    expect(out).toMatch(/revokeTarget\(0x30[Aa]3…0116\)/);
  });

  it('header uses `planPath` as-is (caller has already applied displayPath)', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'foo/bar/baz.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
    });
    expect(text()).toContain('plan: foo/bar/baz.plan.json (1 calls)');
  });

  // --- Safe-level `safe (N)` section ---

  it('plan with only Safe-level calls → `safe (4)` section, no `revokes` / `adds`', async () => {
    const sdk = await loadSdk();
    const safeAddress = '0x40FF9A84a5Da941A060E2925DA228aab328DDe58';
    // Encode 4 Safe-level calldatas using the Safe-ABI signatures.
    const { encodeFunctionData } = await import('viem');
    const SAFE_ABI = [
      {
        type: 'function',
        name: 'setGuard',
        inputs: [{ type: 'address', name: 'guard' }],
        outputs: [],
      },
      {
        type: 'function',
        name: 'setFallbackHandler',
        inputs: [{ type: 'address', name: 'handler' }],
        outputs: [],
      },
      {
        type: 'function',
        name: 'enableModule',
        inputs: [{ type: 'address', name: 'module' }],
        outputs: [],
      },
      {
        type: 'function',
        name: 'disableModule',
        inputs: [
          { type: 'address', name: 'prevModule' },
          { type: 'address', name: 'module' },
        ],
        outputs: [],
      },
    ] as const;
    const GUARD = '0x1234567890123456789012345678901234567890';
    const FALLBACK = '0x2345678901234567890123456789012345678901';
    const MOD_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const MOD_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const PREV = '0xcccccccccccccccccccccccccccccccccccccccc';
    const mk = (
      fn: 'setGuard' | 'setFallbackHandler' | 'enableModule' | 'disableModule',
      a: string,
      b?: string,
    ): PlanCall => {
      const args =
        b === undefined ? [a as `0x${string}`] : [a as `0x${string}`, b as `0x${string}`];
      const data = encodeFunctionData({ abi: SAFE_ABI, functionName: fn, args: args as never });
      return { to: safeAddress, value: '0', data };
    };
    const plan = makePlan([
      mk('setGuard', GUARD),
      mk('setFallbackHandler', FALLBACK),
      mk('enableModule', MOD_A),
      mk('disableModule', PREV, MOD_B),
    ]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'safe.plan.json', safeAddress, out: sink, sdk });
    const out = text();
    expect(out).toMatch(/[├└]─ safe \(4\)/);
    expect(out).not.toContain('revokes (');
    expect(out).not.toContain('adds (');
    expect(out).toMatch(/setGuard\(/);
    expect(out).toMatch(/setFallbackHandler\(/);
    expect(out).toMatch(/enableModule\(/);
    expect(out).toMatch(/disableModule\(/);
    // `prevModule` must NOT be rendered — only `moduleAddress`. viem
    // checksums the address; match case-insensitively. Also assert PREV
    // does not appear in the disableModule line.
    expect(out).toMatch(/disableModule\(0x[bB]{4}…[bB]{4}\)/);
    const disableLine = out.split('\n').find((l) => l.includes('disableModule'))!;
    expect(disableLine.toLowerCase()).not.toContain(PREV.slice(2, 6).toLowerCase());
  });

  it('combined plan (safe + revokes + adds) → section order: safe → revokes → adds', async () => {
    const sdk = await loadSdk();
    const safeAddress = '0x40FF9A84a5Da941A060E2925DA228aab328DDe58';
    const { encodeFunctionData } = await import('viem');
    const SAFE_ABI = [
      {
        type: 'function',
        name: 'setGuard',
        inputs: [{ type: 'address', name: 'guard' }],
        outputs: [],
      },
    ] as const;
    const setGuardCall: PlanCall = {
      to: safeAddress,
      value: '0',
      data: encodeFunctionData({
        abi: SAFE_ABI,
        functionName: 'setGuard',
        args: ['0x1234567890123456789012345678901234567890' as `0x${string}`],
      }),
    };
    const plan = makePlan([
      setGuardCall,
      FIX_REVOKE_TARGET_ETHENA,
      FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B,
    ]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'p.json', safeAddress, out: sink, sdk });
    const out = text();
    const iSafe = out.search(/[├└]─ safe \(/);
    const iRevokes = out.search(/[├└]─ revokes \(/);
    const iAdds = out.search(/[├└]─ adds \(/);
    expect(iSafe).toBeGreaterThan(-1);
    expect(iRevokes).toBeGreaterThan(-1);
    expect(iAdds).toBeGreaterThan(-1);
    expect(iSafe).toBeLessThan(iRevokes);
    expect(iRevokes).toBeLessThan(iAdds);
  });

  it('Safe-level args get the address-label-map annotation', async () => {
    const sdk = await loadSdk();
    const safeAddress = '0x40FF9A84a5Da941A060E2925DA228aab328DDe58';
    const { encodeFunctionData } = await import('viem');
    const SAFE_ABI = [
      {
        type: 'function',
        name: 'setGuard',
        inputs: [{ type: 'address', name: 'guard' }],
        outputs: [],
      },
    ] as const;
    const GUARD = '0x1234567890123456789012345678901234567890';
    const call: PlanCall = {
      to: safeAddress,
      value: '0',
      data: encodeFunctionData({
        abi: SAFE_ABI,
        functionName: 'setGuard',
        args: [GUARD as `0x${string}`],
      }),
    };
    const plan = makePlan([call]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'p.json',
      safeAddress,
      out: sink,
      sdk,
      addressLabelMap: { [GUARD.toLowerCase()]: 'security.guard' },
    });
    expect(text()).toMatch(/setGuard\(0x1234…7890 \(security\.guard\)\)/);
  });

  // --- Ledger-hash preview section (Safe tx + nested signers) ---

  const DOM_MAIN = '0xd00d0000000000000000000000000000000000000000000000000000000000d0';
  const MSG_MAIN = '0xddee0000000000000000000000000000000000000000000000000000000000d1';
  const TX_MAIN = '0xddff0000000000000000000000000000000000000000000000000000000000d2';
  const DOM_CHILD = '0xc11d0000000000000000000000000000000000000000000000000000000000c0';
  const MSG_CHILD = '0xc12d0000000000000000000000000000000000000000000000000000000000c1';
  const TX_CHILD = '0xc13d0000000000000000000000000000000000000000000000000000000000c2';

  it('mainTxPreview + nestedPreview with full hashes → Safe tx block + per-child domain/message/safeTxHash, nonce notes, label, Ledger legend', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const child = '0x1111111111111111111111111111111111111111';
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      mainTxPreview: { domainHash: DOM_MAIN, messageHash: MSG_MAIN, safeTxHash: TX_MAIN, nonce: 7 },
      nestedPreview: [
        {
          child,
          label: 'signers.treasury',
          domainHash: DOM_CHILD,
          messageHash: MSG_CHILD,
          safeTxHash: TX_CHILD,
          nonce: 3,
        },
      ],
    });
    const out = text();
    // Ledger legend.
    expect(out).toContain('(verify Domain hash / Message hash on your Ledger)');
    // Parent Safe tx block.
    expect(out).toContain('Safe tx (preview @ nonce 7 — re-verify at submit)');
    expect(out).toMatch(new RegExp(`domainHash\\s+${DOM_MAIN}`));
    expect(out).toMatch(new RegExp(`messageHash\\s+${MSG_MAIN}`));
    expect(out).toMatch(new RegExp(`safeTxHash\\s+${TX_MAIN}`));
    // Nested signers block — each child approves via approveHash().
    expect(out).toContain(
      'Nested signers (1) — each approves via approveHash(); its owners sign the child tx below',
    );
    expect(out).toContain(`${child} (signers.treasury)  (child nonce 3)`);
    expect(out).toMatch(new RegExp(`domainHash\\s+${DOM_CHILD}`));
    expect(out).toMatch(new RegExp(`messageHash\\s+${MSG_CHILD}`));
    expect(out).toMatch(new RegExp(`safeTxHash\\s+${TX_CHILD}`));
    expect(out).not.toContain('finalized at submit');
  });

  it('degraded preview (domain hashes only) → Safe tx domain + "finalized at submit" notes, child domain + "message/final hash finalized at submit", no nonce', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const child = '0x2222222222222222222222222222222222222222';
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
      mainTxPreview: { domainHash: DOM_MAIN },
      nestedPreview: [{ child, domainHash: DOM_CHILD }],
    });
    const out = text();
    // No nonce → generic preview note on the parent block.
    expect(out).toContain('Safe tx (preview — re-verify at submit)');
    expect(out).not.toContain('@ nonce');
    expect(out).toMatch(new RegExp(`domainHash\\s+${DOM_MAIN}`));
    expect(out).toContain('↳ message hash finalized at submit');
    expect(out).toContain('↳ final hash finalized at submit');
    // Child: domain present, message/final folded into one degraded note; no
    // child-nonce parenthetical in the degraded form.
    expect(out).toMatch(new RegExp(`domainHash\\s+${DOM_CHILD}`));
    expect(out).toContain('↳ message/final hash finalized at submit');
    expect(out).not.toContain('child nonce');
    // Bare child (no label parenthetical).
    expect(out).toMatch(new RegExp(`  ${child}\\n`));
  });

  it('no preview options → no Safe tx / Nested signers section', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
      safeAddress: plan.safeAddress,
      out: sink,
      sdk,
    });
    const out = text();
    expect(out).not.toContain('Nested signers');
    expect(out).not.toContain('Safe tx (preview');
    expect(out).not.toContain('verify Domain hash');
  });
});
