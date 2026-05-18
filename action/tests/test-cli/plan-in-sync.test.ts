import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildProgram } from '../../cli';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-cli-in-sync-'));
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
 * generated sibling. The 0-calls path is exercised because the mocked
 * `planApplyRole` / `planApply` below return `[]`.
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

// Mock the SDK so both `planApplyRole` (legacy per-file) and `planApply`
// (per-safe-dir) return 0 calls — the on-chain state is "in sync" with
// the declared YAML.
vi.mock('zodiac-roles-sdk', async () => {
  const real = await vi.importActual<{
    rolesAbi: readonly unknown[];
    decodeKey: (k: string) => string;
  }>('zodiac-roles-sdk');
  return {
    rolesAbi: real.rolesAbi,
    decodeKey: real.decodeKey,
    encodeKey: (k: string): `0x${string}` => {
      const hex = Buffer.from(k, 'utf8').toString('hex').padEnd(64, '0');
      return `0x${hex}` as `0x${string}`;
    },
    planApplyRole: async (): Promise<Array<{ to: `0x${string}`; data: `0x${string}` }>> => [],
    planApply: async (): Promise<Array<{ to: `0x${string}`; data: `0x${string}` }>> => [],
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

// Even though the 0-calls path skips Safe SDK use, we mock it to guarantee
// no accidental network access if the implementation regresses.
vi.mock('@safe-global/protocol-kit', () => ({
  default: {
    init: async () => {
      throw new Error('Safe SDK must not be initialized when the role state is in sync');
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cli plan — in-sync (0 calls)', () => {
  it('legacy per-file: 0 calls prints "in sync: <path> — nothing to plan" and does NOT write plan.json', async () => {
    const { root, gen } = plantSource();
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    const program = buildProgram();
    const planPath = gen.slice(0, -'.yaml'.length) + '.plan.json';
    expect(existsSync(planPath)).toBe(false);
    let out: string;
    try {
      out = await captureStdout(async () => {
        await program.parseAsync(['plan', root], { from: 'user' });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(out).toContain('in sync:');
    expect(out).toContain('nothing to plan');
    // No plan.json written.
    expect(existsSync(planPath)).toBe(false);
    // No diff was printed.
    expect(out).not.toContain('── adds / changes');
    expect(out).not.toMatch(/plan: .*\.plan\.json/);
    expect(out).not.toContain('planned:');
  });

  it('legacy per-file: existing stale plan.json is NOT overwritten or deleted when in sync', async () => {
    const { root, gen } = plantSource();
    const planPath = gen.slice(0, -'.yaml'.length) + '.plan.json';
    // Plant a stale plan.json (sentinel bytes) — must be left intact.
    const sentinel = '{"stale":true}\n';
    writeFileSync(planPath, sentinel);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    const program = buildProgram();
    try {
      await captureStdout(async () => {
        await program.parseAsync(['plan', root], { from: 'user' });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(readFileSync(planPath, 'utf8')).toBe(sentinel);
  });

  it('per-safe-dir (`--revoke-unmentioned=true`): 0 calls prints "in sync: <dir> — nothing to plan" and does NOT write plan.json', async () => {
    const { root } = plantSource();
    const planPath = join(root, 'mainnet', SAFE, `${SAFE.toLowerCase()}.plan.json`);
    expect(existsSync(planPath)).toBe(false);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    const program = buildProgram();
    let out: string;
    try {
      out = await captureStdout(async () => {
        await program.parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(out).toContain('in sync:');
    expect(out).toContain('nothing to plan');
    expect(existsSync(planPath)).toBe(false);
    expect(out).not.toContain('── adds / changes');
    expect(out).not.toContain('planned:');
  });

  it('overall exit is 0 (no error thrown) when every source is in sync', async () => {
    const { root } = plantSource();
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    const program = buildProgram();
    try {
      // `parseAsync` rejects with a ZacError if the batch failed; in-sync
      // sources must NOT count as a failure.
      await captureStdout(async () => {
        await program.parseAsync(['plan', root], { from: 'user' });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    // If we reached here without throwing, the run is a success.
    expect(true).toBe(true);
  });
});
