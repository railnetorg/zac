import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildProgram } from '../../cli';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-cli-plan-diff-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE = '0x3333333333333333333333333333333333333333';
const MOD = '0x4444444444444444444444444444444444444444';

/**
 * Plant a minimal valid layout `<root>/mainnet/<SAFE>/foo.zac.yaml` +
 * generated sibling that declares one role (no targets / no members) so
 * the legacy per-file plan flow is exercised end-to-end.
 */
function plantSource(): { root: string; src: string; gen: string } {
  const root = makeTempDir();
  const dir = join(root, 'mainnet', SAFE);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'foo.zac.yaml');
  const gen = join(dir, 'foo.yaml');
  writeFileSync(src, '# x\n');
  writeFileSync(
    gen,
    `deployment:
  chain_id: 1
  safe_address: "${SAFE}"
  roles_modifier_address: "${MOD}"
roles:
  ALPHA:
    members: []
    targets: []
`,
  );
  return { root, src, gen };
}

/**
 * A single scopeTarget(ALPHA, MOD) call — easy to assert on. The calldata
 * is the real ABI encoding (selector 0x0c6c76b8 + bytes32 roleKey "ALPHA"
 * right-padded + bytes32-padded address).
 */
const STUB_PLAN_CALL = {
  to: MOD as `0x${string}`,
  data: '0x0c6c76b8414c5048410000000000000000000000000000000000000000000000000000000000000000000000000000004444444444444444444444444444444444444444' as `0x${string}`,
};

/**
 * Capture writes to `process.stdout` during the body of `fn`. Mirrors
 * what `execFile` would do, but in-process so vi.mock applies.
 */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: Buffer[] = [];
  const captureStream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: Buffer | string, enc?: unknown, cb?: unknown): boolean => {
    captureStream.write(chunk);
    if (typeof cb === 'function') (cb as () => void)();
    else if (typeof enc === 'function') (enc as () => void)();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Mock the SDK so `runPlan` returns a deterministic single-call plan
// without hitting the Zodiac subgraph.
vi.mock('zodiac-roles-sdk', async () => {
  // Pull the REAL `rolesAbi` so viem decoding in printPlanDiff still works.
  const real = await vi.importActual<{
    rolesAbi: readonly unknown[];
    decodeKey: (k: string) => string;
  }>('zodiac-roles-sdk');
  return {
    rolesAbi: real.rolesAbi,
    decodeKey: real.decodeKey,
    encodeKey: (k: string): `0x${string}` => {
      // Right-pad the key string into bytes32 hex (matches SDK behavior
      // closely enough for our test — we only need round-trip stability).
      const hex = Buffer.from(k, 'utf8').toString('hex').padEnd(64, '0');
      return `0x${hex}` as `0x${string}`;
    },
    planApplyRole: async (): Promise<Array<{ to: `0x${string}`; data: `0x${string}` }>> => [
      STUB_PLAN_CALL,
    ],
    // Stub the c-builder + processPermissions surface for toSdkTargets.
    c: {
      eq: () => null,
      gt: () => null,
      lt: () => null,
      or: () => null,
      matches: () => null,
      pass: null,
      calldataMatches: () => null,
      avatar: null,
    },
    processPermissions: () => ({ targets: [] }),
  };
});

// Mock the Safe SDK so buildSafeTransaction doesn't hit a real RPC.
vi.mock('@safe-global/protocol-kit', () => ({
  default: {
    init: async () => ({
      createTransaction: async () => ({
        data: {
          baseGas: '0',
          data: '0xdead',
          gasPrice: '0',
          gasToken: '0x0000000000000000000000000000000000000000',
          nonce: 0,
          operation: 0,
          refundReceiver: '0x0000000000000000000000000000000000000000',
          safeTxGas: '0',
          to: MOD,
          value: '0',
        },
      }),
      getTransactionHash: async (): Promise<string> => '0x' + 'b'.repeat(64),
      signHash: async (): Promise<{ data: string }> => ({ data: '0xsig' }),
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cli plan diff wiring', () => {
  it('prints the diff header and a decoded section to stdout for legacy per-file plan', async () => {
    const { root } = plantSource();
    // Plan flow consults `resolveRpcUrl` for the chainId — provide a stub
    // value so we exit the env-check before reaching the (mocked) Safe SDK.
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    const program = buildProgram();
    let out: string;
    try {
      out = await captureStdout(async () => {
        await program.parseAsync(['plan', root], { from: 'user' });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    // Header line.
    expect(out).toMatch(/plan: .*\.plan\.json \(1 calls\)/);
    // Decoded scopeTarget for ALPHA shows up in the adds / changes section.
    expect(out).toContain('── adds / changes (1)');
    expect(out).toContain('ALPHA');
    expect(out).toContain('scopeTarget');
    // Final per-file status line is still emitted.
    expect(out).toMatch(/planned: .*\.plan\.json/);
  });
});
