import { describe, it, expect } from 'vitest';
import { resolveProposalNonce } from '../../apply/safeApi';
import { runBundledSubmit } from '../../apply/runSubmit';
import type { Plan } from '../../apply/planSchema';
import type { Call } from '../../apply/planRoleCalls';

// Anvil default account #0 — never used for real network calls (all stubbed).
const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SAFE = '0x3333333333333333333333333333333333333333';

/**
 * api-kit stub whose `getNextNonce` is configurable. Records how many times
 * it was called so we can assert the override path skips the service.
 */
function makeApiKitCtor(opts: {
  nextNonce?: string;
  throwOnNext?: Error;
  omitGetNextNonce?: boolean;
  calls?: { getNextNonce: number };
}) {
  return class FakeApiKit {
    constructor(_cfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) {}
    async proposeTransaction(): Promise<void> {}
    // Conditionally attach getNextNonce so we can exercise the degraded path.
    getNextNonce = opts.omitGetNextNonce
      ? undefined
      : async (_safeAddress: string): Promise<string> => {
          if (opts.calls) opts.calls.getNextNonce += 1;
          if (opts.throwOnNext) throw opts.throwOnNext;
          return opts.nextNonce ?? '0';
        };
  } as unknown as new (cfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) => {
    proposeTransaction: () => Promise<void>;
  };
}

describe('resolveProposalNonce', () => {
  it('uses an explicit override verbatim and does NOT query the service', async () => {
    const calls = { getNextNonce: 0 };
    const nonce = await resolveProposalNonce({
      chainId: 1,
      safeAddress: SAFE,
      nonceOverride: 42,
      apiKitCtor: makeApiKitCtor({ nextNonce: '7', calls }),
    });
    expect(nonce).toBe(42);
    expect(calls.getNextNonce).toBe(0);
  });

  it('rejects a negative override', async () => {
    await expect(
      resolveProposalNonce({ chainId: 1, safeAddress: SAFE, nonceOverride: -1 }),
    ).rejects.toThrow(/non-negative integer/);
  });

  it('queries getNextNonce (next-after-pending) when no override is given', async () => {
    const calls = { getNextNonce: 0 };
    const nonce = await resolveProposalNonce({
      chainId: 1,
      safeAddress: SAFE,
      apiKitCtor: makeApiKitCtor({ nextNonce: '12', calls }),
    });
    expect(nonce).toBe(12);
    expect(calls.getNextNonce).toBe(1);
  });

  it('degrades to undefined when the api-kit lacks getNextNonce', async () => {
    const nonce = await resolveProposalNonce({
      chainId: 1,
      safeAddress: SAFE,
      apiKitCtor: makeApiKitCtor({ omitGetNextNonce: true }),
    });
    expect(nonce).toBeUndefined();
  });

  it('degrades to undefined when no service URL and no api key are resolvable', async () => {
    // chainId 999999 is not in the per-chain Safe Tx Service map.
    const nonce = await resolveProposalNonce({
      chainId: 999999,
      safeAddress: SAFE,
      apiKitCtor: makeApiKitCtor({ nextNonce: '5' }),
    });
    expect(nonce).toBeUndefined();
  });

  it('surfaces a getNextNonce failure as ZacError(phase=apply)', async () => {
    await expect(
      resolveProposalNonce({
        chainId: 1,
        safeAddress: SAFE,
        apiKitCtor: makeApiKitCtor({ throwOnNext: new Error('503 service unavailable') }),
      }),
    ).rejects.toThrow(/503 service unavailable/);
  });

  it('rejects a non-numeric nonce from the service', async () => {
    await expect(
      resolveProposalNonce({
        chainId: 1,
        safeAddress: SAFE,
        apiKitCtor: makeApiKitCtor({ nextNonce: 'not-a-number' }),
      }),
    ).rejects.toThrow(/invalid next nonce/);
  });

  it.each(['', '   ', '0x10', '1.5', '-3'])(
    'rejects the lax-parse trap value %j instead of silently coercing it',
    async (raw) => {
      await expect(
        resolveProposalNonce({
          chainId: 1,
          safeAddress: SAFE,
          apiKitCtor: makeApiKitCtor({ nextNonce: raw }),
        }),
      ).rejects.toThrow(/invalid next nonce/);
    },
  );
});

// --- Integration: the resolved nonce reaches createTransaction --------------

function makePlan(): Plan {
  return {
    calls: [
      {
        to: '0x4444444444444444444444444444444444444444',
        data: '0xdeadbeef',
        value: '0',
      },
    ],
    callsCount: 1,
    chainId: 1,
    safeAddress: SAFE,
  };
}

/** Safe.init stub that echoes the requested nonce back into `data.nonce`. */
function makeSafeInit(seen: { nonce: number | undefined }) {
  return async () => ({
    createTransaction: async (args: { transactions: Call[]; options?: { nonce?: number } }) => {
      seen.nonce = args.options?.nonce;
      return {
        data: {
          baseGas: '0',
          data: '0xdeadbeef',
          gasPrice: '0',
          gasToken: '0x0000000000000000000000000000000000000000',
          nonce: args.options?.nonce ?? 0,
          operation: 0,
          refundReceiver: '0x0000000000000000000000000000000000000000',
          safeTxGas: '0',
          to: args.transactions[0]!.to,
          value: '0',
        },
      };
    },
    getTransactionHash: async () => '0xfeed' + 'beef'.repeat(15),
    signHash: async (hash: string) => ({ data: '0xsig:' + hash.slice(0, 10) }),
  });
}

describe('runBundledSubmit nonce threading', () => {
  it('builds the Safe tx at the service-resolved next-after-pending nonce', async () => {
    const seen: { nonce: number | undefined } = { nonce: undefined };
    const result = await runBundledSubmit({
      plans: [makePlan()],
      proposerPrivateKey: TEST_KEY,
      rpcUrl: 'http://stub/rpc',
      safeInit: makeSafeInit(seen) as never,
      apiKitCtor: makeApiKitCtor({ nextNonce: '9' }) as never,
    });
    expect(seen.nonce).toBe(9);
    expect(result.safeTxData.nonce).toBe(9);
  });

  it('honors an explicit --nonce override end-to-end', async () => {
    const seen: { nonce: number | undefined } = { nonce: undefined };
    const result = await runBundledSubmit({
      plans: [makePlan()],
      proposerPrivateKey: TEST_KEY,
      rpcUrl: 'http://stub/rpc',
      nonce: 3,
      safeInit: makeSafeInit(seen) as never,
      apiKitCtor: makeApiKitCtor({ nextNonce: '9' }) as never,
    });
    expect(seen.nonce).toBe(3);
    expect(result.safeTxData.nonce).toBe(3);
  });
});
