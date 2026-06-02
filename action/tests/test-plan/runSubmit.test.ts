import { describe, it, expect } from 'vitest';
import { runSubmit } from '../../apply/runSubmit';
import type { Plan, SafeTxData } from '../../apply/planSchema';

const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const ZERO = '0x0000000000000000000000000000000000000000';

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
};

// The Safe tx is built fresh at submit time — this is what the stubbed Safe
// returns from createTransaction/getTransactionHash and what must be posted.
const BUILT_TX_DATA: SafeTxData = {
  baseGas: '0',
  data: '0xbuilt',
  gasPrice: '0',
  gasToken: ZERO,
  nonce: 7,
  operation: 0,
  refundReceiver: ZERO,
  safeTxGas: '0',
  to: PLAN.safeAddress,
  value: '0',
};
const BUILT_HASH = '0xfeed' + 'beef'.repeat(15);

describe('runSubmit', () => {
  it('TM-4: DI — builds the Safe tx from calls at submit, then posts the BUILT data + hash', async () => {
    let proposed: {
      safeAddress: string;
      safeTransactionData: unknown;
      safeTxHash: string;
      senderAddress: string;
      senderSignature: string;
    } | null = null;
    let apiKitCfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string } | null = null;

    const safeInit = async (cfg: { provider: string; signer?: string; safeAddress: string }) => {
      expect(cfg.safeAddress).toBe(PLAN.safeAddress);
      return {
        createTransaction: async () => ({ data: BUILT_TX_DATA }),
        getTransactionHash: async () => BUILT_HASH,
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

    expect(result.safeTxHash).toBe(BUILT_HASH);
    expect(result.safeTxData).toEqual(BUILT_TX_DATA);
    expect(result.callsCount).toBe(1);
    expect(proposed).not.toBeNull();
    const p = proposed as unknown as {
      safeAddress: string;
      safeTransactionData: unknown;
      safeTxHash: string;
      senderAddress: string;
      senderSignature: string;
    };
    expect(p.safeAddress).toBe(PLAN.safeAddress);
    expect(p.safeTxHash).toBe(BUILT_HASH);
    expect(p.safeTransactionData).toEqual(BUILT_TX_DATA);
    expect(p.senderSignature).toBe('0xsig:feedbeef');
    expect(p.senderAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(apiKitCfg).not.toBeNull();
    expect((apiKitCfg as unknown as { chainId: bigint }).chainId).toBe(1n);
  });
});
