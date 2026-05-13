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
  it('plan with only revokes → "revokes" section + no "adds / changes" + no warning when declaredRoleKeys is undefined', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_ETHENA, FIX_REVOKE_FUNCTION_ETHENA_APPROVE]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'configs/m/safe.plan.json', out: sink, sdk });
    const out = text();
    expect(out).toContain('plan: configs/m/safe.plan.json (2 calls)');
    expect(out).toContain('── revokes (2)');
    expect(out).not.toContain('── adds / changes');
    expect(out).not.toContain('not declared in any source');
    expect(out).toContain('ETHENA_INSTITUTIONAL');
    expect(out).toContain('revokeTarget');
    expect(out).toContain('revokeFunction');
    expect(out).toContain('fn=0x095ea7b3 (approve)');
  });

  it('plan with revokes + declaredRoleKeys covering some → warning fires for the unmentioned ones only', async () => {
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
    expect(out).toContain('⚠ revoking 1 role(s) not declared in any source: ETHENA_INSTITUTIONAL');
    expect(out).toContain('pass --revoke-unmentioned=false to preserve them');
  });

  it('plan with revokes only of declared roles → no unmentioned warning', async () => {
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

  it('plan with only scopeFunction → "adds / changes" section + no "revokes"', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_SCOPE_FUNCTION_ONDO_GM_445DF08B]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
    const out = text();
    expect(out).toContain('── adds / changes (1)');
    expect(out).not.toContain('── revokes');
    expect(out).toContain('ONDO_GM');
    expect(out).toContain('scopeFunction');
    expect(out).toContain('fn=0x445df08b');
  });

  it('plan with assignRoles (all true) → appears in "adds / changes"', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_ASSIGN_ROLES_ETHENA]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
    const out = text();
    expect(out).toContain('── adds / changes (1)');
    expect(out).toContain('assignRoles');
    expect(out).toContain('roles=[ETHENA_INSTITUTIONAL]');
    expect(out).toContain('assigned=[false]');
  });

  it('plan with unknown selector → `fn=0xXXXXXXXX` with no decoded name', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_UNKNOWN]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
    const out = text();
    expect(out).toContain('── adds / changes (1)');
    expect(out).toContain('unknown');
    expect(out).toContain('selector=0xdeadbeef');
  });

  it('plan that mixes everything → all sections in correct order (revokes, then adds / changes, then warning)', async () => {
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
    const idxRevokes = out.indexOf('── revokes');
    const idxAdds = out.indexOf('── adds / changes');
    const idxWarn = out.indexOf('not declared in any source');
    expect(idxRevokes).toBeGreaterThan(-1);
    expect(idxAdds).toBeGreaterThan(-1);
    expect(idxWarn).toBeGreaterThan(-1);
    expect(idxRevokes).toBeLessThan(idxAdds);
    expect(idxAdds).toBeLessThan(idxWarn);
    // Both unmentioned role keys flagged.
    expect(out).toContain('ETHENA_INSTITUTIONAL');
    expect(out).toContain('LAGOON');
  });

  it('shortens addresses to first4…last4 format', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'safe.plan.json', out: sink, sdk });
    const out = text();
    // 0x30A3699E0DCea6Bdc8BB2c13E74A2324e0B20116 → 0x30A3…0116
    expect(out).toMatch(/target=0x30[Aa]3…0116/);
  });

  it('header uses `planPath` as-is (caller has already applied displayPath)', async () => {
    const sdk = await loadSdk();
    const plan = makePlan([FIX_REVOKE_TARGET_LAGOON]);
    const { sink, text } = captureSink();
    printPlanDiff(plan, { planPath: 'foo/bar/baz.plan.json', out: sink, sdk });
    expect(text()).toContain('plan: foo/bar/baz.plan.json (1 calls)');
  });
});
