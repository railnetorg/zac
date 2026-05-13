import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanForSafeDir } from '../../apply/runPlanForSafeDir';
import type { PlanApplyFn } from '../../apply/planSafeDirCalls';
import type { Call } from '../../apply/planRoleCalls';
import { ZacError } from '../../errors';
import { findSafeDirs } from '../../discover';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-run-plan-safedir-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE_A = '0x3333333333333333333333333333333333333333';
const MOD_A = '0x4444444444444444444444444444444444444444';

function plantSafeDir(args: {
  network: 'mainnet';
  chainId: number;
  safeAddress: string;
  modifierAddress: string;
  files: Array<{ name: string; roleKey: string }>;
}): { root: string; safeDir: string } {
  const root = makeTempDir();
  const dir = join(root, args.network, args.safeAddress.toLowerCase());
  mkdirSync(dir, { recursive: true });
  for (const f of args.files) {
    writeFileSync(join(dir, `${f.name}.zac.yaml`), '# x\n');
    writeFileSync(
      join(dir, `${f.name}.yaml`),
      `deployment:
  chain_id: ${args.chainId}
  safe_address: "${args.safeAddress}"
  roles_modifier_address: "${args.modifierAddress}"
roles:
  ${f.roleKey}:
    members:
      - "0x1111111111111111111111111111111111111111"
    targets: []
`,
    );
  }
  return { root, safeDir: dir };
}

const fakeEncodeKey = (k: string): `0x${string}` => `0x${k.padEnd(64, '0')}` as `0x${string}`;

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

describe('runPlanForSafeDir', () => {
  it('TS-10: aggregates two sources, calls planApply once with union, returns a single Plan', async () => {
    const { root } = plantSafeDir({
      network: 'mainnet',
      chainId: 1,
      safeAddress: SAFE_A,
      modifierAddress: MOD_A,
      files: [
        { name: 'a', roleKey: 'ALPHA' },
        { name: 'b', roleKey: 'BRAVO' },
      ],
    });
    const safeDirs = findSafeDirs(root);
    expect(safeDirs).toHaveLength(1);

    let planApplyCallCount = 0;
    let captured: { rolesCount: number; chainId: number; address: string } | null = null;
    const planApply: PlanApplyFn = async (desired, meta) => {
      planApplyCallCount++;
      captured = {
        rolesCount: desired.roles.length,
        chainId: meta.chainId,
        address: meta.address,
      };
      return [
        {
          to: MOD_A as `0x${string}`,
          data: '0xdeadbeef' as `0x${string}`,
        },
      ];
    };

    const plan = await runPlanForSafeDir({
      safeDir: safeDirs[0]!,
      planApply,
      encodeKey: fakeEncodeKey,
      safeInit: safeInitStub(),
      rpcUrl: 'http://stub/rpc',
    });
    expect(planApplyCallCount).toBe(1);
    expect(captured!.rolesCount).toBe(2);
    expect(captured!.chainId).toBe(1);
    expect(captured!.address.toLowerCase()).toBe(MOD_A.toLowerCase());
    expect(plan.callsCount).toBe(1);
    expect(plan.calls).toEqual([{ to: MOD_A, value: '0', data: '0xdeadbeef' }]);
    expect(plan.safeAddress.toLowerCase()).toBe(SAFE_A.toLowerCase());
    expect(plan.modifierAddress.toLowerCase()).toBe(MOD_A.toLowerCase());
    expect(plan.chainId).toBe(1);
    expect(plan.safeTxHash).toMatch(/^0xabc/);
  });

  it('TS-11: planApply returning 0 calls → ZacError(phase=apply, role state in sync)', async () => {
    const { root } = plantSafeDir({
      network: 'mainnet',
      chainId: 1,
      safeAddress: SAFE_A,
      modifierAddress: MOD_A,
      files: [{ name: 'a', roleKey: 'ALPHA' }],
    });
    const safeDirs = findSafeDirs(root);
    const planApply: PlanApplyFn = async () => [];
    try {
      await runPlanForSafeDir({
        safeDir: safeDirs[0]!,
        planApply,
        encodeKey: fakeEncodeKey,
        safeInit: safeInitStub(),
        rpcUrl: 'http://stub/rpc',
      });
      throw new Error('expected runPlanForSafeDir to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).phase).toBe('apply');
      expect((e as ZacError).message).toContain('0 calls');
    }
  });

  it('TS-12: revoke calls (data prefix differs from any grant) flow through unchanged', async () => {
    // The SDK natively emits revokes for unmentioned roles; we just assert
    // wire-through: whatever bytes the SDK emits land in plan.calls verbatim.
    const { root } = plantSafeDir({
      network: 'mainnet',
      chainId: 1,
      safeAddress: SAFE_A,
      modifierAddress: MOD_A,
      files: [{ name: 'a', roleKey: 'ALPHA' }],
    });
    const safeDirs = findSafeDirs(root);
    const planApply: PlanApplyFn = async () => [
      { to: MOD_A as `0x${string}`, data: '0x11111111' as `0x${string}` },
      { to: MOD_A as `0x${string}`, data: '0x22222222' as `0x${string}` },
      // Imagine this is the auto-emitted revoke for role BRAVO that exists
      // on-chain but is not in the aggregated desired set.
      { to: MOD_A as `0x${string}`, data: '0x99999999' as `0x${string}` },
    ];
    const plan = await runPlanForSafeDir({
      safeDir: safeDirs[0]!,
      planApply,
      encodeKey: fakeEncodeKey,
      safeInit: safeInitStub(),
      rpcUrl: 'http://stub/rpc',
    });
    expect(plan.calls).toHaveLength(3);
    expect(plan.calls.map((c) => c.data)).toEqual(['0x11111111', '0x22222222', '0x99999999']);
  });
});
