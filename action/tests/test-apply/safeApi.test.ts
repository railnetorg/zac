import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApply } from '../../apply/runApply';
import type { PlanApplyRoleFn, Call } from '../../apply/planRoleCalls';
import { ZacError } from '../../errors';

// Anvil default account #0. We never make real network calls — Safe.init
// and SafeApiKit are both injected stubs.
const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-safeapi-'));
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

interface ProposeRecord {
  safeAddress: string;
  safeTxHash: string;
  senderAddress: string;
  senderSignature: string;
  txServiceUrl: string | undefined;
  apiKey: string | undefined;
  chainId: bigint;
}

function buildStubs(propose: { record: ProposeRecord[]; throwOnPropose?: Error }) {
  const safeInitStub = async (cfg: { provider: string; signer?: string; safeAddress: string }) => {
    void cfg;
    return {
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
      getTransactionHash: async (_tx: { data: unknown }) => '0xfeed' + 'beef'.repeat(15),
      signHash: async (hash: string) => ({ data: '0xsig:' + hash.slice(0, 10) }),
    };
  };
  let lastKitConfig: { chainId: bigint; txServiceUrl?: string; apiKey?: string } = {
    chainId: 0n,
  };
  class FakeApiKit {
    constructor(cfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) {
      lastKitConfig = cfg;
    }
    async proposeTransaction(args: {
      safeAddress: string;
      safeTransactionData: unknown;
      safeTxHash: string;
      senderAddress: string;
      senderSignature: string;
    }): Promise<void> {
      if (propose.throwOnPropose) throw propose.throwOnPropose;
      propose.record.push({
        safeAddress: args.safeAddress,
        safeTxHash: args.safeTxHash,
        senderAddress: args.senderAddress,
        senderSignature: args.senderSignature,
        txServiceUrl: lastKitConfig.txServiceUrl,
        apiKey: lastKitConfig.apiKey,
        chainId: lastKitConfig.chainId,
      });
    }
  }
  return { safeInitStub, FakeApiKit };
}

const planFn: PlanApplyRoleFn = async () => [
  {
    to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
    data: '0xdeadbeef' as `0x${string}`,
  },
];

describe('runApply end-to-end (Safe sign + propose)', () => {
  it('T11-11: signs and proposes — defaults txServiceUrl from chainId map, derives senderAddress from proposer key', async () => {
    const record: ProposeRecord[] = [];
    const { safeInitStub, FakeApiKit } = buildStubs({ record });
    const result = await runApply({
      generatedPath: writeGenerated(),
      proposerPrivateKey: TEST_KEY,
      planApplyRole: planFn,
      encodeKey: fakeEncodeKey,
      safeInit: safeInitStub,
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });
    expect(result).not.toBeNull();
    expect(result!.safeTxHash).toMatch(/^0xfeed/);
    expect(record).toHaveLength(1);
    expect(record[0]!.safeAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(record[0]!.txServiceUrl).toBe('https://safe-transaction-mainnet.safe.global/api');
    expect(record[0]!.apiKey).toBeUndefined();
    expect(record[0]!.chainId).toBe(1n);
    // The sender address must be derived from the proposer key, not zero.
    expect(record[0]!.senderAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(record[0]!.senderAddress).not.toBe('0x0000000000000000000000000000000000000000');
  });

  it('T11-12: api-kit error surfaces as ZacError(phase=apply) with the upstream message', async () => {
    const record: ProposeRecord[] = [];
    const { safeInitStub, FakeApiKit } = buildStubs({
      record,
      throwOnPropose: new Error('429 too many requests'),
    });
    await expect(
      runApply({
        generatedPath: writeGenerated(),
        proposerPrivateKey: TEST_KEY,
        planApplyRole: planFn,
        encodeKey: fakeEncodeKey,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
        rpcUrl: 'http://stub/rpc',
      }),
    ).rejects.toThrow(ZacError);
    try {
      await runApply({
        generatedPath: writeGenerated(),
        proposerPrivateKey: TEST_KEY,
        planApplyRole: planFn,
        encodeKey: fakeEncodeKey,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
        rpcUrl: 'http://stub/rpc',
      });
    } catch (e) {
      expect((e as ZacError).phase).toBe('apply');
      expect((e as ZacError).message).toContain('429');
    }
  });
});
