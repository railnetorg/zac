import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const CLI = resolve(REPO_ROOT, 'action/cli.ts');

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

describe('cli --revoke-unmentioned flag', () => {
  it('TS-20: `plan --help` mentions `--revoke-unmentioned`', async () => {
    const { code, stdout } = await runCli(['plan', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--revoke-unmentioned');
  });

  it('TS-21: `apply --help` mentions `--revoke-unmentioned`', async () => {
    const { code, stdout } = await runCli(['apply', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--revoke-unmentioned');
  });

  it('TS-22: `submit --help` does NOT mention `--revoke-unmentioned` (flag is plan/apply only)', async () => {
    const { code, stdout } = await runCli(['submit', '--help']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('--revoke-unmentioned');
  });

  it('TS-23: invalid value for `--revoke-unmentioned` exits non-zero with a phase= error', async () => {
    // No path, but the flag parse fails first.
    const { code, stderr } = await runCli(['plan', '--revoke-unmentioned', 'maybe', '/x']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('phase=');
  });
});
