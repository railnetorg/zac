import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApply } from '../../apply/runApply';
import type { PlanApplyRoleFn } from '../../apply/planRoleCalls';
import type { Call } from '../../apply/planRoleCalls';
import { ZacError } from '../../errors';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-apply-int-'));
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

const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const fakeEncodeKey = (_key: string): `0x${string}` => `0x${'a'.repeat(64)}` as `0x${string}`;

function safeInitStub() {
  return async (_cfg: { provider: string; signer?: string; safeAddress: string }) => ({
    createTransaction: async (args: { transactions: Call[] }) => ({
      data: { transactions: args.transactions },
    }),
    getTransactionHash: async (_tx: { data: unknown }) =>
      '0xabc' + '1234567890'.repeat(6) + '12345',
    signHash: async (_hash: string) => ({ data: '0xsig' }),
  });
}

class FakeApiKit {
  static lastInstance: FakeApiKit | undefined;
  proposed: Array<{ safeTxHash: string; safeAddress: string }> = [];
  constructor(public config: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) {
    FakeApiKit.lastInstance = this;
  }
  async proposeTransaction(args: {
    safeAddress: string;
    safeTransactionData: unknown;
    safeTxHash: string;
    senderAddress: string;
    senderSignature: string;
  }): Promise<void> {
    this.proposed.push({ safeTxHash: args.safeTxHash, safeAddress: args.safeAddress });
  }
}

describe('runApply', () => {
  it('T11-13: end-to-end with stubbed SDK + Safe APIs returns a safeTxHash', async () => {
    const planFn: PlanApplyRoleFn = async () => [
      {
        to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
        data: '0xdeadbeef' as `0x${string}`,
      },
    ];
    const result = await runApply({
      generatedPath: writeGenerated(),
      proposerPrivateKey: TEST_KEY,
      planApplyRole: planFn,
      encodeKey: fakeEncodeKey,
      safeInit: safeInitStub(),
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });
    expect(result.safeTxHash).toMatch(/^0xabc/);
    expect(FakeApiKit.lastInstance!.proposed).toHaveLength(1);
  });

  it('T11-14: missing ZAC_PROPOSER_PRIVATE_KEY → ZacError(phase=apply)', async () => {
    const original = process.env['ZAC_PROPOSER_PRIVATE_KEY'];
    delete process.env['ZAC_PROPOSER_PRIVATE_KEY'];
    try {
      await expect(
        runApply({
          generatedPath: writeGenerated(),
          planApplyRole: (async () => []) as PlanApplyRoleFn,
          encodeKey: fakeEncodeKey,
          safeInit: safeInitStub(),
          apiKitCtor: FakeApiKit,
        }),
      ).rejects.toThrow(ZacError);
    } finally {
      if (original !== undefined) process.env['ZAC_PROPOSER_PRIVATE_KEY'] = original;
    }
  });

  it('T11-15: planApplyRole returning 0 calls → ZacError(phase=apply, "0 calls")', async () => {
    const planFn: PlanApplyRoleFn = async () => [];
    try {
      await runApply({
        generatedPath: writeGenerated(),
        proposerPrivateKey: TEST_KEY,
        planApplyRole: planFn,
        encodeKey: fakeEncodeKey,
        safeInit: safeInitStub(),
        apiKitCtor: FakeApiKit,
        rpcUrl: 'http://stub/rpc',
      });
      throw new Error('expected runApply to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).phase).toBe('apply');
      expect((e as ZacError).message).toContain('0 calls');
    }
  });
});
