import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CLI = resolve(__dirname, '../../cli.ts');
const REPO_ROOT = resolve(__dirname, '../../..');

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('bun', [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('cli', () => {
  it('T2-10: --help exits 0 and stdout contains "generate"', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('generate');
  });

  it('T2-11: generate (no arg) exits non-zero', async () => {
    const { code, stderr } = await runCli(['generate']);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('T2-12: generate <nonexistent> exits 1 with phase= in stderr', async () => {
    const { code, stderr } = await runCli(['generate', '/definitely/does/not/exist.yaml']);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=');
  });

  it('T2-13: --out flag is parsed (still errors via stub, but parsing succeeds)', async () => {
    const { code, stderr } = await runCli([
      'generate',
      '/x.yaml',
      '--out',
      '/tmp/zac-test-out.yaml',
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=');
  });

  it('T2-14: --config flag is parsed', async () => {
    const { code, stderr } = await runCli(['generate', '/x.yaml', '--config', '/y/config.yaml']);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=');
  });

  it('T2-15: README documents host invocation', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('bun ./submodules/zac/action/cli.ts');
  });
});
