import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan } from '../../apply/runPlan';
import type { PlanApplyRoleFn, Call } from '../../apply/planRoleCalls';
import { ZacError } from '../../errors';
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

function safeInitStub() {
  return async (_cfg: { provider: string; signer?: string; safeAddress: string }) => ({
    createTransaction: async (args: { transactions: Call[] }) => ({
      data: {
        baseGas: '0',
        data: '0xdeadbeef',
        gasPrice: '0',
        gasToken: '0x0000000000000000000000000000000000000000',
        nonce: 0,
        operation: 0,
        refundReceiver: '0x0000000000000000000000000000000000000000',
        safeTxGas: '0',
        to: args.transactions[0]!.to,
        value: '0',
      },
    }),
    getTransactionHash: async (_tx: { data: unknown }) =>
      '0xabc' + '1234567890'.repeat(6) + '12345',
    signHash: async (_hash: string) => ({ data: '0xsig' }),
  });
}

describe('runPlan', () => {
  it('TM-1: returns a Plan with calls.length>=1, valid safeTxHash, and round-trips via serializePlan + parsePlan', async () => {
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
      safeInit: safeInitStub(),
    });
    expect(plan.calls.length).toBeGreaterThanOrEqual(1);
    expect(plan.callsCount).toBe(plan.calls.length);
    expect(plan.safeTxHash).toMatch(/^0xabc/);
    expect(plan.safeAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(plan.modifierAddress).toBe('0x4444444444444444444444444444444444444444');
    expect(plan.chainId).toBe(1);
    // Round-trip.
    const json = serializePlan(plan);
    expect(() => PlanSchema.parse(JSON.parse(json))).not.toThrow();
    const parsed = parsePlan(json);
    expect(parsed.safeTxHash).toBe(plan.safeTxHash);
    expect(parsed.callsCount).toBe(plan.callsCount);
  });

  it('TM-2: DI happy path — mocked planApplyRole + safeInit; assert call forwarding shape', async () => {
    let safeInitArgs: unknown = null;
    const safeInit = async (cfg: { provider: string; signer?: string; safeAddress: string }) => {
      safeInitArgs = cfg;
      return {
        createTransaction: async (args: { transactions: Call[] }) => ({
          data: {
            baseGas: '0',
            data: '0x',
            gasPrice: '0',
            gasToken: '0x0000000000000000000000000000000000000000',
            nonce: 5,
            operation: 0,
            refundReceiver: '0x0000000000000000000000000000000000000000',
            safeTxGas: '0',
            to: args.transactions[0]!.to,
            value: '0',
          },
        }),
        getTransactionHash: async (_tx: { data: unknown }) => '0xfeed' + 'beef'.repeat(15),
        signHash: async (_hash: string) => ({ data: '0xsig' }),
      };
    };
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
      safeInit,
      rpcUrl: 'http://stub/rpc',
    });
    expect(safeInitArgs).toMatchObject({
      provider: 'http://stub/rpc',
      safeAddress: '0x3333333333333333333333333333333333333333',
    });
    expect((safeInitArgs as { signer?: string }).signer).toBeUndefined();
    expect(planFnArgs).toMatchObject({
      meta: {
        chainId: 1,
        address: '0x4444444444444444444444444444444444444444',
      },
    });
  });

  it('TM-3: planApplyRole returning 0 calls → ZacError(phase=apply, "0 calls")', async () => {
    const planFn: PlanApplyRoleFn = async () => [];
    try {
      await runPlan({
        generatedPath: writeGenerated(),
        planApplyRole: planFn,
        encodeKey: fakeEncodeKey,
        safeInit: safeInitStub(),
      });
      throw new Error('expected runPlan to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).phase).toBe('apply');
      expect((e as ZacError).message).toContain('0 calls');
    }
  });
});
