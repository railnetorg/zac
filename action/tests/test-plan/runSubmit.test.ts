import { describe, it, expect } from 'vitest';
import { runSubmit } from '../../apply/runSubmit';
import type { Plan } from '../../apply/planSchema';

const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const PLAN: Plan = {
  calls: [
    {
      to: '0x4444444444444444444444444444444444444444',
      value: '0',
      data: '0xdeadbeef',
    },
  ],
  callsCount: 1,
  chainId: 1,
  modifierAddress: '0x4444444444444444444444444444444444444444',
  safeAddress: '0x3333333333333333333333333333333333333333',
  safeTxData: {
    baseGas: '0',
    data: '0xdeadbeef',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    nonce: 0,
    operation: 0,
    refundReceiver: '0x0000000000000000000000000000000000000000',
    safeTxGas: '0',
    to: '0x4444444444444444444444444444444444444444',
    value: '0',
  },
  safeTxHash: '0xfeed' + 'beef'.repeat(15),
};

describe('runSubmit', () => {
  it('TM-4: DI — api-kit proposeTransaction called with plan.safeTxData + plan.safeTxHash + signed signature', async () => {
    let proposed: {
      safeAddress: string;
      safeTransactionData: unknown;
      safeTxHash: string;
      senderAddress: string;
      senderSignature: string;
    } | null = null;
    let apiKitCfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string } | null = null;

    const safeInit = async (cfg: { provider: string; signer?: string; safeAddress: string }) => {
      expect(cfg.signer).toBe(TEST_KEY);
      expect(cfg.safeAddress).toBe(PLAN.safeAddress);
      return {
        createTransaction: async () => ({ data: {} }),
        getTransactionHash: async () => '0xunused',
        signHash: async (hash: string) => ({ data: '0xsig:' + hash.slice(2, 10) }),
      };
    };

    class FakeApiKit {
      constructor(cfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) {
        apiKitCfg = cfg;
      }
      async proposeTransaction(args: {
        safeAddress: string;
        safeTransactionData: unknown;
        safeTxHash: string;
        senderAddress: string;
        senderSignature: string;
      }): Promise<void> {
        proposed = args;
      }
    }

    const result = await runSubmit({
      plan: PLAN,
      proposerPrivateKey: TEST_KEY,
      safeInit,
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });

    expect(result.safeTxHash).toBe(PLAN.safeTxHash);
    expect(proposed).not.toBeNull();
    const p = proposed as unknown as {
      safeAddress: string;
      safeTransactionData: unknown;
      safeTxHash: string;
      senderAddress: string;
      senderSignature: string;
    };
    expect(p.safeAddress).toBe(PLAN.safeAddress);
    expect(p.safeTxHash).toBe(PLAN.safeTxHash);
    expect(p.safeTransactionData).toEqual(PLAN.safeTxData);
    expect(p.senderSignature).toBe('0xsig:feedbeef');
    expect(p.senderAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(apiKitCfg).not.toBeNull();
    expect((apiKitCfg as unknown as { chainId: bigint }).chainId).toBe(1n);
  });
});
