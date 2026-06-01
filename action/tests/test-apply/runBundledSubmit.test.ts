import { describe, it, expect } from 'vitest';
import { runBundledSubmit } from '../../apply/runSubmit';
import { groupPlansBySafe } from '../../discover';
import { ZacError } from '../../errors';
import type { Plan } from '../../apply/planSchema';
import type { Call } from '../../apply/planRoleCalls';

// Anvil default account #0 — never makes real network calls; both Safe.init
// and SafeApiKit are injected stubs.
const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const SAFE_A = '0x3333333333333333333333333333333333333333';
const SAFE_B = '0x5555555555555555555555555555555555555555';

function makePlan(overrides: { safeAddress: string; chainId: number; calls?: Call[] }): Plan {
  return {
    calls: overrides.calls ?? [
      {
        to: '0x4444444444444444444444444444444444444444',
        value: '0',
        data: '0xdeadbeef',
      },
    ],
    callsCount: overrides.calls?.length ?? 1,
    chainId: overrides.chainId,
    modifierAddress: '0x4444444444444444444444444444444444444444',
    safeAddress: overrides.safeAddress,
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
    safeTxHash: '0xfeedbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef',
  };
}

interface CreateTxRecord {
  transactions: Call[];
}

interface ProposeRecord {
  safeAddress: string;
  safeTxHash: string;
  safeTransactionData: unknown;
}

function buildStubs() {
  const createTxCalls: CreateTxRecord[] = [];
  const safeInitStub = async (cfg: { provider: string; signer?: string; safeAddress: string }) => {
    void cfg;
    return {
      createTransaction: async (args: { transactions: Call[] }) => {
        createTxCalls.push({ transactions: args.transactions });
        // `SafeTransactionLike.data` narrows to `{to, value, data, operation?}`
        // — what protocol-kit's Safe.createTransaction returns. The transactions
        // array isn't part of that shape; the test wants to inspect it
        // separately via `createTxCalls`.
        return {
          data: {
            to: args.transactions[0]!.to,
            value: '0',
            data: '0xfake-tx-data',
            operation: 0,
          },
        };
      },
      getTransactionHash: async (_tx: { data: unknown }) => '0xfeed' + 'beef'.repeat(15),
      signHash: async (hash: string) => ({ data: '0xsig:' + hash.slice(0, 10) }),
    };
  };
  const proposeCalls: ProposeRecord[] = [];
  class FakeApiKit {
    constructor(_cfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) {
      void _cfg;
    }
    async proposeTransaction(args: {
      safeAddress: string;
      safeTransactionData: unknown;
      safeTxHash: string;
      senderAddress: string;
      senderSignature: string;
    }): Promise<void> {
      proposeCalls.push({
        safeAddress: args.safeAddress,
        safeTxHash: args.safeTxHash,
        safeTransactionData: args.safeTransactionData,
      });
    }
  }
  return { safeInitStub, FakeApiKit, createTxCalls, proposeCalls };
}

describe('runBundledSubmit', () => {
  it('TB-10: rejects empty plans array', async () => {
    const { safeInitStub, FakeApiKit } = buildStubs();
    await expect(
      runBundledSubmit({
        plans: [],
        proposerPrivateKey: TEST_KEY,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
      }),
    ).rejects.toThrow(ZacError);
  });

  it('TB-11: rejects plans with mismatched safeAddress', async () => {
    const { safeInitStub, FakeApiKit } = buildStubs();
    await expect(
      runBundledSubmit({
        plans: [
          makePlan({ safeAddress: SAFE_A, chainId: 1 }),
          makePlan({ safeAddress: SAFE_B, chainId: 1 }),
        ],
        proposerPrivateKey: TEST_KEY,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
      }),
    ).rejects.toThrow(ZacError);
  });

  it('TB-12: rejects plans with mismatched chainId', async () => {
    const { safeInitStub, FakeApiKit } = buildStubs();
    await expect(
      runBundledSubmit({
        plans: [
          makePlan({ safeAddress: SAFE_A, chainId: 1 }),
          makePlan({ safeAddress: SAFE_A, chainId: 137 }),
        ],
        proposerPrivateKey: TEST_KEY,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
      }),
    ).rejects.toThrow(ZacError);
  });

  it("TB-13: single plan → single createTransaction call with that plan's calls", async () => {
    const { safeInitStub, FakeApiKit, createTxCalls, proposeCalls } = buildStubs();
    const call: Call = {
      to: '0x4444444444444444444444444444444444444444',
      value: '0',
      data: '0xaaaa',
    };
    const plan = makePlan({ safeAddress: SAFE_A, chainId: 1, calls: [call] });
    await runBundledSubmit({
      plans: [plan],
      proposerPrivateKey: TEST_KEY,
      safeInit: safeInitStub,
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });
    expect(createTxCalls).toHaveLength(1);
    expect(createTxCalls[0]!.transactions).toEqual([call]);
    expect(proposeCalls).toHaveLength(1);
    expect(proposeCalls[0]!.safeAddress).toBe(SAFE_A);
  });

  it('TB-14: N plans → ONE createTransaction call with concatenated calls in input order', async () => {
    const { safeInitStub, FakeApiKit, createTxCalls, proposeCalls } = buildStubs();
    const c1: Call = { to: SAFE_A, value: '0', data: '0xaaaa' };
    const c2: Call = { to: SAFE_A, value: '0', data: '0xbbbb' };
    const c3: Call = { to: SAFE_A, value: '0', data: '0xcccc' };
    await runBundledSubmit({
      plans: [
        makePlan({ safeAddress: SAFE_A, chainId: 1, calls: [c1, c2] }),
        makePlan({ safeAddress: SAFE_A, chainId: 1, calls: [c3] }),
      ],
      proposerPrivateKey: TEST_KEY,
      safeInit: safeInitStub,
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });
    expect(createTxCalls).toHaveLength(1);
    expect(createTxCalls[0]!.transactions).toEqual([c1, c2, c3]);
    // Exactly one proposal — that's the bundling guarantee.
    expect(proposeCalls).toHaveLength(1);
  });

  it('TB-15a: directory-mode orchestration — multiple plans across two safes produce ONE proposeTransaction per safe', async () => {
    const { safeInitStub, FakeApiKit, createTxCalls, proposeCalls } = buildStubs();
    const cA1: Call = { to: SAFE_A, value: '0', data: '0xa1' };
    const cA2: Call = { to: SAFE_A, value: '0', data: '0xa2' };
    const cB1: Call = { to: SAFE_B, value: '0', data: '0xb1' };
    const plans: Plan[] = [
      makePlan({ safeAddress: SAFE_A, chainId: 1, calls: [cA1] }),
      makePlan({ safeAddress: SAFE_B, chainId: 1, calls: [cB1] }),
      makePlan({ safeAddress: SAFE_A, chainId: 1, calls: [cA2] }),
    ];
    // Mirror what the CLI does in directory-mode: group, then submit each
    // group through `runBundledSubmit`.
    const groups = groupPlansBySafe(plans);
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      await runBundledSubmit({
        plans: group.plans,
        proposerPrivateKey: TEST_KEY,
        safeInit: safeInitStub,
        apiKitCtor: FakeApiKit,
        rpcUrl: 'http://stub/rpc',
      });
    }
    // Exactly one createTransaction + one proposeTransaction per safe.
    expect(createTxCalls).toHaveLength(2);
    expect(proposeCalls).toHaveLength(2);
    // Safe A bundled its two calls; Safe B kept its one call.
    const safeAPropose = proposeCalls.find((p) => p.safeAddress === SAFE_A);
    const safeBPropose = proposeCalls.find((p) => p.safeAddress === SAFE_B);
    expect(safeAPropose).toBeDefined();
    expect(safeBPropose).toBeDefined();
    const safeACreate = createTxCalls.find((c) => c.transactions.some((t) => t.data === '0xa1'));
    expect(safeACreate!.transactions).toEqual([cA1, cA2]);
    const safeBCreate = createTxCalls.find((c) => c.transactions.some((t) => t.data === '0xb1'));
    expect(safeBCreate!.transactions).toEqual([cB1]);
  });

  it('TB-15: proposed safeTxHash is the FRESHLY-COMPUTED hash from protocol-kit, not the stored per-plan hash', async () => {
    const { safeInitStub, FakeApiKit, proposeCalls } = buildStubs();
    // Stored hash is a distinct value (all zeros after the prefix) so we can
    // assert the proposed hash is NOT the stored one.
    const storedHash = '0x' + '0'.repeat(64);
    const plan: Plan = {
      ...makePlan({ safeAddress: SAFE_A, chainId: 1 }),
      safeTxHash: storedHash,
    };
    const result = await runBundledSubmit({
      plans: [plan, plan],
      proposerPrivateKey: TEST_KEY,
      safeInit: safeInitStub,
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });
    expect(result.safeTxHash).toMatch(/^0xfeed/);
    expect(proposeCalls[0]!.safeTxHash).toBe(result.safeTxHash);
    expect(result.safeTxHash).not.toBe(storedHash);
  });

  it('TB-16: returns the freshly-computed bundled safeTxData and total callsCount so callers can render the post-bundle view', async () => {
    const { safeInitStub, FakeApiKit } = buildStubs();
    const cA1: Call = { to: SAFE_A, value: '0', data: '0xa1' };
    const cA2: Call = { to: SAFE_A, value: '0', data: '0xa2' };
    const result = await runBundledSubmit({
      plans: [
        makePlan({ safeAddress: SAFE_A, chainId: 1, calls: [cA1] }),
        makePlan({ safeAddress: SAFE_A, chainId: 1, calls: [cA2] }),
      ],
      proposerPrivateKey: TEST_KEY,
      safeInit: safeInitStub,
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });
    // callsCount is the sum across plans, not any single plan's count.
    expect(result.callsCount).toBe(2);
    // safeTxData comes from the bundled createTransaction stub (data: '0xfake-tx-data').
    expect(result.safeTxData.data).toBe('0xfake-tx-data');
    expect(result.safeTxData.to).toBe(SAFE_A);
  });
});
