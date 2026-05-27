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
    safeTxData: {
      baseGas: '0',
      data: '0x',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      nonce: 0,
      operation: 0,
      refundReceiver: '0x0000000000000000000000000000000000000000',
      safeTxGas: '0',
      to: MODIFIER,
      value: '0',
    },
    safeTxHash: '0x' + 'a'.repeat(64),
  };
}

describe('printPlanDiff', () => {
  it('plan with only revokes → "revokes (N)" tree section + no "adds" + no unmentioned annotation when declaredRoleKeys is undefined', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_ETHENA, FIX_REVOKE_FUNCTION_ETHENA_APPROVE]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'configs/m/safe.plan.json', out: sink, sdk });
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
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
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
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
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
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
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
      '0x2c158bc456e027b2affccadf1bdbd9f5fc4c5c8c:0x445df08b': {
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

  it('functionParamMap: scopeFunction with no matching entry falls back to leaf rendering (no param subtree)', async () => {
    const sdk = await loadSdk();
    // Empty paramMap — same fixture, but no source-side entry to expand into.
    const plan = makePlan([FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, {
      planPath: 'safe.plan.json',
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
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
    const out = text();
    // 0x30A3699E0DCea6Bdc8BB2c13E74A2324e0B20116 → 0x30A3…0116
    expect(out).toMatch(/revokeTarget\(0x30[Aa]3…0116\)/);
  });

  it('header uses `planPath` as-is (caller has already applied displayPath)', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'foo/bar/baz.plan.json', out: sink, sdk });
    expect(text()).toContain('plan: foo/bar/baz.plan.json (1 calls)');
  });
});
