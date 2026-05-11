import { describe, it, expect } from 'vitest';
import { proposeToSafe } from '../../apply/safeApi';
import type { Call } from '../../apply/planRoleCalls';
import { ZacError } from '../../errors';

// A deterministic test key (Anvil default account #0). We never make real
// network calls — Safe.init and SafeApiKit are both injected stubs.
const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const SAFE = '0x3333333333333333333333333333333333333333';
const calls: Call[] = [
  {
    to: '0x4444444444444444444444444444444444444444',
    value: '0',
    data: '0xdeadbeef',
  },
];

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
        data: { transactions: args.transactions, marker: 'fake-tx-data' },
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

describe('proposeToSafe', () => {
  it('T11-11: signs and proposes — defaults txServiceUrl from chainId map', async () => {
    const record: ProposeRecord[] = [];
    const { safeInitStub, FakeApiKit } = buildStubs({ record });
    const result = await proposeToSafe({
      chainId: 1,
      safeAddress: SAFE,
      calls,
      proposerPrivateKey: TEST_KEY,
      safeInit: safeInitStub,
      apiKitCtor: FakeApiKit,
    });
    expect(result.safeTxHash).toMatch(/^0xfeed/);
    expect(record).toHaveLength(1);
    expect(record[0]!.safeAddress).toBe(SAFE);
    expect(record[0]!.txServiceUrl).toBe('https://safe-transaction-mainnet.safe.global/api');
    expect(record[0]!.apiKey).toBeUndefined();
    expect(record[0]!.chainId).toBe(1n);
    // The sender address must be derived from the proposer key, not zero.
    expect(record[0]!.senderAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(record[0]!.senderAddress).not.toBe('0x0000000000000000000000000000000000000000');
  });

  it('T11-12: api-kit error surfaces as ZacError(phase=apply)', async () => {
    const record: ProposeRecord[] = [];
    const { safeInitStub, FakeApiKit } = buildStubs({
      record,
      throwOnPropose: new Error('429 too many requests'),
    });
    await expect(
      proposeToSafe({
        chainId: 1,
        safeAddress: SAFE,
        calls,
        proposerPrivateKey: TEST_KEY,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
      }),
    ).rejects.toThrow(ZacError);
    try {
      await proposeToSafe({
        chainId: 1,
        safeAddress: SAFE,
        calls,
        proposerPrivateKey: TEST_KEY,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
      });
    } catch (e) {
      expect((e as ZacError).phase).toBe('apply');
      expect((e as ZacError).message).toContain('429');
    }
  });
});
