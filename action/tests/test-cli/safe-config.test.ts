import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildProgram } from '../../cli';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-cli-safe-config-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE = '0x3333333333333333333333333333333333333333';
const MOD = '0x4444444444444444444444444444444444444444';
const GUARD_LIVE = '0x0000000000000000000000000000000000000000';
const GUARD_DESIRED = '0x1234567890123456789012345678901234567890';

function plantWithSafeYaml(safeYamlBody: string): { root: string; safeDir: string } {
  const root = makeTempDir();
  writeFileSync(join(root, 'config.yaml'), 'aliases: {}\n');
  const safeDir = join(root, 'mainnet', SAFE);
  mkdirSync(safeDir, { recursive: true });
  writeFileSync(join(safeDir, 'foo.zac.yaml'), '# x\n');
  writeFileSync(
    join(safeDir, 'foo.yaml'),
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
  writeFileSync(join(safeDir, 'safe.yaml'), safeYamlBody);
  return { root, safeDir };
}

function plantWithoutSafeYaml(): { root: string; safeDir: string; src: string } {
  const root = makeTempDir();
  writeFileSync(join(root, 'config.yaml'), 'aliases: {}\n');
  const safeDir = join(root, 'mainnet', SAFE);
  mkdirSync(safeDir, { recursive: true });
  const src = join(safeDir, 'foo.zac.yaml');
  writeFileSync(src, '# x\n');
  writeFileSync(
    join(safeDir, 'foo.yaml'),
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
  return { root, safeDir, src };
}

async function captureStdout(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const outStream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      outChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  const errStream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      errChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: Buffer | string, enc?: unknown, cb?: unknown): boolean => {
    outStream.write(chunk);
    if (typeof cb === 'function') (cb as () => void)();
    else if (typeof enc === 'function') (enc as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: Buffer | string, enc?: unknown, cb?: unknown): boolean => {
    errStream.write(chunk);
    if (typeof cb === 'function') (cb as () => void)();
    else if (typeof enc === 'function') (enc as () => void)();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
  };
}

// Live Safe state — mutable so each test can preconfigure. The `vi.mock`
// factories are hoisted and capture these by reference, so mutations in
// `beforeEach`/individual tests are reflected at call time.
let liveGuard = GUARD_LIVE;
let liveFallback = '0x0000000000000000000000000000000000000000';
let liveModules: string[] = [MOD];

// Role calls returned by the SDK in per-safe-dir aggregated mode. Default
// `[]` ⇒ "no role state changes" so most tests focus purely on safe.yaml.
// One test overrides this to assert combined-plan ordering.
let mockedPlanApplyResult: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];

// SDK mock.
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
    planApply: async (): Promise<Array<{ to: `0x${string}`; data: `0x${string}` }>> =>
      mockedPlanApplyResult,
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

// Configurable Safe stub.
vi.mock('@safe-global/protocol-kit', () => ({
  default: {
    init: async () => ({
      createTransaction: async () => ({
        data: { to: SAFE, value: '0', data: '0xbundled', operation: 0 },
      }),
      getTransactionHash: async () => '0x' + 'a'.repeat(64),
      signHash: async () => ({ data: '0xsig' }),
      getGuard: async () => liveGuard,
      getFallbackHandler: async () => liveFallback,
      getModules: async () => liveModules,
      createEnableGuardTx: async (a: string) => ({
        data: { to: SAFE, value: '0', data: `0xsetGuard:${a.toLowerCase()}`, operation: 0 },
      }),
      createEnableFallbackHandlerTx: async (a: string) => ({
        data: { to: SAFE, value: '0', data: `0xsetFallback:${a.toLowerCase()}`, operation: 0 },
      }),
      createEnableModuleTx: async (a: string) => ({
        data: { to: SAFE, value: '0', data: `0xenableModule:${a.toLowerCase()}`, operation: 0 },
      }),
      createDisableModuleTx: async (a: string) => ({
        data: { to: SAFE, value: '0', data: `0xdisableModule:${a.toLowerCase()}`, operation: 0 },
      }),
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  liveGuard = GUARD_LIVE;
  liveFallback = '0x0000000000000000000000000000000000000000';
  liveModules = [MOD];
  mockedPlanApplyResult = [];
});

/**
 * Safe-only safe-dir helper: writes ONLY a `safe.yaml` (no `.zac.yaml`
 * siblings). Exercises the `findSafeYamls` → `buildSafeDir(sources=[])`
 * path through the CLI.
 */
function plantSafeOnly(safeYamlBody: string): { root: string; safeDir: string } {
  const root = makeTempDir();
  writeFileSync(join(root, 'config.yaml'), 'aliases: {}\n');
  const safeDir = join(root, 'mainnet', SAFE);
  mkdirSync(safeDir, { recursive: true });
  writeFileSync(join(safeDir, 'safe.yaml'), safeYamlBody);
  return { root, safeDir };
}

describe('cli safe.yaml integration', () => {
  it('`plan --revoke-unmentioned=true <dir>` with safe.yaml guard differing from live → plan.json with 1 setGuard call', async () => {
    const { root, safeDir } = plantWithSafeYaml(`guard: "${GUARD_DESIRED}"
fallback: ~
modules:
  - "${MOD}"
`);
    const planPath = join(safeDir, `${SAFE.toLowerCase()}.plan.json`);
    expect(existsSync(planPath)).toBe(false);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      calls: Array<{ to: string; data: string }>;
    };
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.data).toContain('setGuard');
    expect(outErr.stdout).toContain('planned:');
  });

  it('`plan --revoke-unmentioned=false <dir>` does NOT read safe.yaml (decoy: malformed safe.yaml is present)', async () => {
    const { root, safeDir } = plantWithSafeYaml('this is :: not :: valid yaml\n');
    // Legacy per-file path — planApplyRole returns [] (in sync), no plan.json.
    const planPath = join(safeDir, 'foo.plan.json');
    expect(existsSync(planPath)).toBe(false);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', root], { from: 'user' });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    // The malformed safe.yaml was NOT read — no parse error on stderr.
    expect(outErr.stderr).not.toContain('safe.yaml');
    expect(outErr.stdout).toContain('in sync:');
  });

  it('`plan <file.zac.yaml>` (file mode) does NOT read safe.yaml (decoy)', async () => {
    const { root, src, safeDir } = plantWithoutSafeYaml();
    writeFileSync(join(safeDir, 'safe.yaml'), 'this is :: not :: valid yaml\n');
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', src], { from: 'user' });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    void root;
    expect(outErr.stderr).not.toContain('safe.yaml');
    expect(outErr.stdout).toContain('in sync:');
  });

  it('cross-validation failure: safe.yaml modules: [Z] + .zac.yaml declaring modifier A → error names the offending file', async () => {
    const OTHER = '0x9999999999999999999999999999999999999999';
    const { root, safeDir } = plantWithSafeYaml(`guard: ~
fallback: ~
modules:
  - "${OTHER}"
`);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        // Per-safe-dir batch failure throws "one or more plan steps failed"
        // AFTER logging the per-step error to stderr — catch + ignore here.
        try {
          await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
            from: 'user',
          });
        } catch {
          // expected
        }
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    void safeDir;
    expect(outErr.stderr).toContain('foo.zac.yaml');
    expect(outErr.stderr).toContain('does not include the roles modifier');
  });

  it('safe.yaml is OPTIONAL when .zac.yaml siblings exist (no safe.yaml → role-only plan still works)', async () => {
    const { root } = plantWithoutSafeYaml();
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(outErr.stderr).not.toContain('safe.yaml not found');
    expect(outErr.stdout).toContain('in sync:');
  });

  // ── End-to-end coverage for the other 3 Safe-level ops ───────────────────

  it('setFallbackHandler end-to-end: safe.yaml fallback differs from live → plan.json with 1 setFallbackHandler call', async () => {
    const FALLBACK_DESIRED = '0xfeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0';
    const { root, safeDir } = plantWithSafeYaml(`guard: ~
fallback: "${FALLBACK_DESIRED}"
modules:
  - "${MOD}"
`);
    const planPath = join(safeDir, `${SAFE.toLowerCase()}.plan.json`);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    try {
      await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      calls: Array<{ to: string; data: string }>;
    };
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.data).toContain('setFallback');
    expect(plan.calls[0]!.data).toContain(FALLBACK_DESIRED.toLowerCase());
  });

  it('enableModule end-to-end: safe.yaml lists a new module not on-chain → plan.json with enableModule + cross-validation passes (modifier still listed)', async () => {
    const NEW_MOD = '0xabcdef0000000000000000000000000000000001';
    // Desired: modifier (preserved) + new module. Live: only modifier.
    liveModules = [MOD];
    const { root, safeDir } = plantWithSafeYaml(`guard: ~
fallback: ~
modules:
  - "${MOD}"
  - "${NEW_MOD}"
`);
    const planPath = join(safeDir, `${SAFE.toLowerCase()}.plan.json`);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    try {
      await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      calls: Array<{ to: string; data: string }>;
    };
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.data).toContain('enableModule');
    expect(plan.calls[0]!.data).toContain(NEW_MOD.toLowerCase());
  });

  it('disableModule end-to-end: safe.yaml omits an on-chain module → plan.json with disableModule for the omitted address', async () => {
    const EXTRA_MOD = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    // Live has both; desired keeps only the modifier (preserves it explicitly).
    liveModules = [EXTRA_MOD, MOD];
    const { root, safeDir } = plantWithSafeYaml(`guard: ~
fallback: ~
modules:
  - "${MOD}"
`);
    const planPath = join(safeDir, `${SAFE.toLowerCase()}.plan.json`);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    try {
      await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      calls: Array<{ to: string; data: string }>;
    };
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.data).toContain('disableModule');
    expect(plan.calls[0]!.data).toContain(EXTRA_MOD.toLowerCase());
  });

  it('combined plan: safe.yaml setGuard + role-modifier call → plan.json carries BOTH calls with Safe-level FIRST', async () => {
    // One role call comes from the SDK; one Safe-level call from safe.yaml.
    mockedPlanApplyResult = [{ to: MOD as `0x${string}`, data: '0xroleCall' as `0x${string}` }];
    const { root, safeDir } = plantWithSafeYaml(`guard: "${GUARD_DESIRED}"
fallback: ~
modules:
  - "${MOD}"
`);
    const planPath = join(safeDir, `${SAFE.toLowerCase()}.plan.json`);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    try {
      await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      calls: Array<{ to: string; data: string }>;
    };
    expect(plan.calls).toHaveLength(2);
    // Ordering invariant: safe-level (to=SAFE) MUST precede role-modifier (to=MOD).
    expect(plan.calls[0]!.to.toLowerCase()).toBe(SAFE.toLowerCase());
    expect(plan.calls[0]!.data).toContain('setGuard');
    expect(plan.calls[1]!.to.toLowerCase()).toBe(MOD.toLowerCase());
    expect(plan.calls[1]!.data).toBe('0xroleCall');
  });

  it('safe-only safe-dir (no .zac.yaml) flows through the CLI end-to-end → plan.json with Safe-level call', async () => {
    const { root, safeDir } = plantSafeOnly(`guard: "${GUARD_DESIRED}"
fallback: ~
modules: ~
`);
    const planPath = join(safeDir, `${SAFE.toLowerCase()}.plan.json`);
    expect(existsSync(planPath)).toBe(false);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    try {
      await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      calls: Array<{ to: string; data: string }>;
      modifierAddress?: string;
    };
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]!.data).toContain('setGuard');
    // Safe-only plan must NOT carry a modifierAddress.
    expect(plan.modifierAddress).toBeUndefined();
  });

  it('managed-but-in-sync (idempotent): safe.yaml guard matches live, modules matches live → no plan.json, "in sync"', async () => {
    // Pre-set live to match what safe.yaml will declare.
    liveGuard = GUARD_DESIRED;
    liveModules = [MOD];
    const { root, safeDir } = plantWithSafeYaml(`guard: "${GUARD_DESIRED}"
fallback: ~
modules:
  - "${MOD}"
`);
    const planPath = join(safeDir, `${SAFE.toLowerCase()}.plan.json`);
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['plan', '--revoke-unmentioned', 'true', root], {
          from: 'user',
        });
      });
    } finally {
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(existsSync(planPath)).toBe(false);
    expect(outErr.stdout).toContain('in sync:');
  });
});
