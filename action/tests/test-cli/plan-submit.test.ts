import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const CLI = resolve(REPO_ROOT, 'action/cli.ts');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-cli-plan-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileP('bun', [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('cli plan + submit', () => {
  it('TM-7a: --help lists "plan" and "submit" subcommands', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('plan');
    expect(stdout).toContain('submit');
  });

  it('TM-7b: plan --help describes JSON output + no-signing', async () => {
    const { code, stdout } = await runCli(['plan', '--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/JSON|json/);
    expect(stdout).toMatch(/no signing|no-signing/i);
  });

  it('TM-7c: submit --help mentions ZAC_PROPOSER_PRIVATE_KEY', async () => {
    const { code, stdout } = await runCli(['submit', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('ZAC_PROPOSER_PRIVATE_KEY');
  });

  it('TM-7d: submit <nonexistent> exits non-zero', async () => {
    const env = { ...process.env };
    delete env['ZAC_PROPOSER_PRIVATE_KEY'];
    const { code, stderr } = await runCli(['submit', '/definitely/does/not/exist.json'], env);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('TM-7f: submit <empty-dir> exits non-zero with "no matching files found"', async () => {
    const d = makeTempDir();
    const env = { ...process.env };
    env['ZAC_PROPOSER_PRIVATE_KEY'] =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const { code, stderr } = await runCli(['submit', d], env);
    expect(code).not.toBe(0);
    expect(stderr).toContain('no matching files found');
  });

  it('TM-7g: submit --help mentions auto-bundling', async () => {
    const { code, stdout } = await runCli(['submit', '--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/bundle|bundled/i);
  });

  it('TM-7h: submit <dir> with BOTH aggregated + per-file plans in one safe-dir → phase=apply rejection', async () => {
    // Plant a safe-dir that contains BOTH styles of plan file (the legacy
    // per-file `<stem>.plan.json` AND the per-modifier aggregated
    // `<safe-address>.plan.json`). The CLI must refuse before bundling so
    // the user doesn't end up submitting duplicated calls.
    const root = makeTempDir();
    const safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const dir = join(root, 'mainnet', safe);
    mkdirSync(dir, { recursive: true });
    const aggregatedPath = join(dir, `mainnet.${safe}.plan.json`);
    const perFilePath = join(dir, 'aave_safe.plan.json');
    // The legacy per-file detection looks for a sibling `<stem>.zac.yaml`.
    writeFileSync(join(dir, 'aave_safe.zac.yaml'), '# x\n');
    const plan = {
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
      safeAddress: safe,
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
    writeFileSync(aggregatedPath, JSON.stringify(plan));
    writeFileSync(perFilePath, JSON.stringify(plan));
    const env = { ...process.env };
    env['ZAC_PROPOSER_PRIVATE_KEY'] =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const { code, stderr } = await runCli(['submit', root], env);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=apply');
    expect(stderr).toContain('BOTH legacy per-file');
    expect(stderr).toContain('mutually exclusive');
  });

  // --- stale / unclassifiable plan artifacts in a safe-dir -----------------
  // `plan` writes the aggregated plan as `<network>.<safe-address>.plan.json`
  // and never deletes anything, so a safe-dir can accumulate plan files whose
  // calls describe superseded revisions. `submit` walks the dir recursively
  // and flattens every plan it finds into ONE Safe proposal, so anything it
  // fails to reject here is silently signed and posted.

  const SAFE_S = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  function planBody(data: string): string {
    return JSON.stringify({
      calls: [{ to: '0x4444444444444444444444444444444444444444', value: '0', data }],
      callsCount: 1,
      chainId: 1,
      modifierAddress: '0x4444444444444444444444444444444444444444',
      safeAddress: SAFE_S,
      safeTxData: {
        baseGas: '0',
        data,
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
    });
  }

  function plantSafeDir(files: Record<string, string>): { root: string; dir: string } {
    const root = makeTempDir();
    const dir = join(root, 'mainnet', SAFE_S);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return { root, dir };
  }

  const submitEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    ZAC_PROPOSER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    // Unroutable: if a case is wrongly accepted it fails at the RPC boundary
    // instead of reaching the Safe Transaction Service.
    MAINNET_RPC_URL: 'http://127.0.0.1:1/deadend',
  });

  it('TM-7i: stale `<safe-address>.plan.json` alongside the current `<network>.<safe-address>.plan.json` → rejected', async () => {
    // The rename left the un-qualified file on disk. Both parse, both group
    // under the same (safe, chainId), and runBundledSubmit would flatMap them
    // into one proposal carrying a superseded revision's calls.
    const { root } = plantSafeDir({
      [`${SAFE_S}.plan.json`]: planBody('0xdeadbeef'),
      [`mainnet.${SAFE_S}.plan.json`]: planBody('0xcafebabe'),
    });
    const { code, stderr } = await runCli(['submit', root], submitEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('phase=apply');
    expect(stderr).toContain('stale aggregated plan');
    expect(stderr).toContain(`${SAFE_S}.plan.json`);
  });

  it('TM-7j: a stale `<safe-address>.plan.json` ON ITS OWN is rejected (in-sync safe-dir writes no new plan)', async () => {
    // When a safe-dir is in sync `plan` writes nothing, so the stale file is
    // the ONLY plan present — a count-based check would see one aggregated
    // plan and wave it through.
    const { root } = plantSafeDir({ [`${SAFE_S}.plan.json`]: planBody('0xdeadbeef') });
    const { code, stderr } = await runCli(['submit', root], submitEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('stale aggregated plan');
  });

  it('TM-7k: orphan `<stem>.plan.json` with no sibling `<stem>.zac.yaml` → rejected', async () => {
    const { root } = plantSafeDir({ 'deleted_source.plan.json': planBody('0xdeadbeef') });
    const { code, stderr } = await runCli(['submit', root], submitEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('orphan plan file');
    expect(stderr).toContain('deleted_source.plan.json');
  });

  it('TM-7l: a per-file plan whose stem ends in `.<safe-address>` still counts as per-file', async () => {
    // Exercises the aggregated match being exact rather than a suffix test:
    // this stem ends with `.<safe-address>` but has a live sibling source, so
    // it must reach the mixed-style check instead of passing as aggregated.
    const stem = `vault.${SAFE_S}`;
    const { root, dir } = plantSafeDir({
      [`${stem}.plan.json`]: planBody('0xdeadbeef'),
      [`mainnet.${SAFE_S}.plan.json`]: planBody('0xcafebabe'),
    });
    writeFileSync(join(dir, `${stem}.zac.yaml`), '# x\n');
    const { code, stderr } = await runCli(['submit', root], submitEnv());
    expect(code).toBe(1);
    expect(stderr).toContain('BOTH legacy per-file');
    expect(stderr).toContain(`${stem}.plan.json`);
  });

  it('TM-7m: a flat directory of collected plan files is not rejected by the safe-dir checks', async () => {
    // Release assets are downloaded into one flat dir with no
    // `<network>/<safe-address>/` structure and no sibling sources. Every file
    // would look like an orphan, so the checks must skip non-safe-dirs. Getting
    // as far as the RPC boundary proves the guard let it through.
    const root = makeTempDir();
    writeFileSync(join(root, `mainnet.${SAFE_S}.plan.json`), planBody('0xdeadbeef'));
    const { code, stderr } = await runCli(['submit', root], submitEnv());
    expect(code).toBe(1);
    expect(stderr).not.toContain('orphan plan file');
    expect(stderr).not.toContain('stale aggregated plan');
    expect(stderr).toContain('Safe.init failed');
  });

  it('TM-7e: submit with a syntactically-valid plan but no ZAC_PROPOSER_PRIVATE_KEY → phase=apply error', async () => {
    const d = makeTempDir();
    const planPath = join(d, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
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
        safeTxHash: '0xfeedbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef',
      }),
    );
    const env = { ...process.env };
    delete env['ZAC_PROPOSER_PRIVATE_KEY'];
    const { code, stderr } = await runCli(['submit', planPath], env);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=apply');
    expect(stderr).toContain('ZAC_PROPOSER_PRIVATE_KEY');
  });
});
