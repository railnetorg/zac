import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApply } from '../../apply/runApply';
import type { PlanApplyRoleFn, Call } from '../../apply/planRoleCalls';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-run-apply-reg-'));
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

describe('runApply (chained wrapper regression)', () => {
  it('TM-5: chained runPlan + runSubmit produces the same observable behavior as the pre-refactor runApply (signed hash returned, propose called once)', async () => {
    let proposeCount = 0;
    let receivedHash = '';
    const planFn: PlanApplyRoleFn = async () => [
      {
        to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
        data: '0xdeadbeef' as `0x${string}`,
      },
    ];
    const safeInit = async (_cfg: { provider: string; signer?: string; safeAddress: string }) => ({
      createTransaction: async (args: { transactions: Call[] }) => ({
        data: {
          baseGas: '0',
          data: '0x',
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
    class FakeApiKit {
      constructor(_cfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) {}
      async proposeTransaction(args: {
        safeAddress: string;
        safeTransactionData: unknown;
        safeTxHash: string;
        senderAddress: string;
        senderSignature: string;
      }): Promise<void> {
        proposeCount++;
        receivedHash = args.safeTxHash;
      }
    }
    const result = await runApply({
      generatedPath: writeGenerated(),
      proposerPrivateKey: TEST_KEY,
      planApplyRole: planFn,
      encodeKey: fakeEncodeKey,
      safeInit,
      apiKitCtor: FakeApiKit,
      rpcUrl: 'http://stub/rpc',
    });
    expect(result.safeTxHash).toMatch(/^0xabc/);
    expect(proposeCount).toBe(1);
    expect(receivedHash).toBe(result.safeTxHash);
  });
});
