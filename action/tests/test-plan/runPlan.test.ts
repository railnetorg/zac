import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan } from '../../apply/runPlan';
import type { PlanApplyRoleFn } from '../../apply/planRoleCalls';
import { PlanSchema, serializePlan, parsePlan } from '../../apply/planSchema';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-run-plan-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function writeGenerated(): string {
  const d = makeTempDir();
  const p = join(d, 'gen.yaml');
  writeFileSync(
    p,
    `deployment:
  chain_id: 1
  safe_address: "0x3333333333333333333333333333333333333333"
  roles_modifier_address: "0x4444444444444444444444444444444444444444"
roles:
  AAVE_V3:
    members:
      - "0x1111111111111111111111111111111111111111"
    targets:
      - address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
        functions:
          - signature: "function approve(address spender, uint256 amount)"
            execution_options: none
`,
  );
  return p;
}

const fakeEncodeKey = (_key: string): `0x${string}` => `0x${'a'.repeat(64)}` as `0x${string}`;

describe('runPlan', () => {
  it('TM-1: returns a calldata-only Plan (calls + ids, no Safe tx) that round-trips via serializePlan + parsePlan', async () => {
    const planFn: PlanApplyRoleFn = async () => [
      {
        to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
        data: '0xdeadbeef' as `0x${string}`,
      },
    ];
    const plan = await runPlan({
      generatedPath: writeGenerated(),
      planApplyRole: planFn,
      encodeKey: fakeEncodeKey,
    });
    expect(plan).not.toBeNull();
    expect(plan!.calls.length).toBeGreaterThanOrEqual(1);
    expect(plan!.callsCount).toBe(plan!.calls.length);
    expect(plan!.safeAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(plan!.modifierAddress).toBe('0x4444444444444444444444444444444444444444');
    expect(plan!.chainId).toBe(1);
    // No Safe tx is built at plan time (RPC-free).
    expect((plan as unknown as { safeTxHash?: unknown }).safeTxHash).toBeUndefined();
    // Round-trip.
    const json = serializePlan(plan!);
    expect(() => PlanSchema.parse(JSON.parse(json))).not.toThrow();
    const parsed = parsePlan(json);
    expect(parsed.callsCount).toBe(plan!.callsCount);
    expect(parsed.calls).toEqual(plan!.calls);
  });

  it('TM-2: DI happy path — mocked planApplyRole; assert call-forwarding shape (no RPC/Safe init)', async () => {
    let planFnArgs: unknown = null;
    const planFn: PlanApplyRoleFn = async (desired, meta) => {
      planFnArgs = { desired, meta };
      return [
        {
          to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
          data: '0xc0ffee' as `0x${string}`,
        },
      ];
    };
    await runPlan({
      generatedPath: writeGenerated(),
      planApplyRole: planFn,
      encodeKey: fakeEncodeKey,
    });
    expect(planFnArgs).toMatchObject({
      meta: {
        chainId: 1,
        address: '0x4444444444444444444444444444444444444444',
      },
    });
  });

  it('TM-3: planApplyRole returning 0 calls → returns null ("in sync"), does NOT throw', async () => {
    const planFn: PlanApplyRoleFn = async () => [];
    const result = await runPlan({
      generatedPath: writeGenerated(),
      planApplyRole: planFn,
      encodeKey: fakeEncodeKey,
    });
    expect(result).toBeNull();
  });
});
