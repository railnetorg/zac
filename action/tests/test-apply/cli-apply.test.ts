import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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

describe('cli apply', () => {
  it('T11-16: --help lists "apply" subcommand', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('apply');
  });

  it('T11-17: apply --help mentions ZAC_PROPOSER_PRIVATE_KEY', async () => {
    const { code, stdout } = await runCli(['apply', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('ZAC_PROPOSER_PRIVATE_KEY');
  });

  it('T11-18: apply (no arg) exits non-zero', async () => {
    const { code, stderr } = await runCli(['apply']);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('T11-19: apply <nonexistent> exits 1 with phase=apply in stderr', async () => {
    // Strip ZAC_PROPOSER_PRIVATE_KEY from env so the parse error surfaces (or
    // the missing-key error does — either is phase=apply).
    const env = { ...process.env };
    delete env['ZAC_PROPOSER_PRIVATE_KEY'];
    const { code, stderr } = await runCli(['apply', '/definitely/does/not/exist.yaml'], env);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=apply');
  });

  it('T11-20: README documents zac apply + ZAC_PROPOSER_PRIVATE_KEY', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('zac apply');
    expect(readme).toContain('ZAC_PROPOSER_PRIVATE_KEY');
  });
});
