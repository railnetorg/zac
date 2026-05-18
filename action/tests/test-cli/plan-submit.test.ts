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
    // `<safe-address>.plan.json`) under the safe's `txs/` subdir. The CLI
    // must refuse before bundling so the user doesn't end up submitting
    // duplicated calls.
    const root = makeTempDir();
    const safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const dir = join(root, 'mainnet', safe);
    const configDir = join(dir, 'config');
    const txsDir = join(dir, 'txs');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(txsDir, { recursive: true });
    const aggregatedPath = join(txsDir, `${safe}.plan.json`);
    const perFilePath = join(txsDir, 'aave_safe.plan.json');
    // The legacy per-file detection looks for a sibling
    // `../config/<stem>.zac.yaml`.
    writeFileSync(join(configDir, 'aave_safe.zac.yaml'), '# x\n');
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
