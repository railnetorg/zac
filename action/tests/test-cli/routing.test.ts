import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const execFileP = promisify(execFile);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const CLI = resolve(REPO_ROOT, 'action/cli.ts');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-cli-routing-'));
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

/**
 * Plant a layout that violates the strict
 * `<network>/<safe-address>/config/<name>.zac.yaml` convention: the
 * source lives directly under a `<network>/<safe-address>/` dir but NOT
 * inside a `config/` subdir (the old, pre-tri-folder layout). This lets
 * us verify which code path the CLI takes:
 *
 * - file-mode: layout validation fires immediately (`phase=validate`).
 * - dir-mode (default and `--revoke-unmentioned=true`): the walker
 *   silently skips sources outside `config/`, so the run surfaces an
 *   empty-batch "no matching files found" stderr; the file is treated as
 *   if it weren't there.
 */
function plantOldLayout(): string {
  const root = makeTempDir();
  const safe = '0x3333333333333333333333333333333333333333';
  const dir = join(root, 'mainnet', safe);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'foo.zac.yaml'), '# x\n');
  writeFileSync(
    join(dir, 'foo.yaml'),
    `deployment:
  chain_id: 1
  safe_address: "${safe}"
  roles_modifier_address: "0x4444444444444444444444444444444444444444"
roles: {}
`,
  );
  return root;
}

describe('cli routing (dir vs file, --revoke-unmentioned)', () => {
  it('TS-40: dir-mode with `--revoke-unmentioned=true` SILENTLY SKIPS sources outside `config/` (walker filter); the batch surfaces "no matching files found"', async () => {
    const root = plantOldLayout();
    const { code, stderr } = await runCli(['plan', '--revoke-unmentioned', 'true', root]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('no matching files found');
  });

  it('TS-41: dir-mode with default flag (legacy mode) ALSO silently skips sources outside `config/`', async () => {
    const root = plantOldLayout();
    const { code, stderr } = await runCli(['plan', root]);
    expect(code).not.toBe(0);
    // The legacy walker goes through `findGeneratedConfigs`, which only
    // surfaces `*.yaml` under `zac-out/` — none here.
    expect(stderr).toContain('no matching files found');
  });

  it('TS-42: file-mode HARD-ERRORS on the pre-refactor layout regardless of flag value', async () => {
    const root = plantOldLayout();
    const src = resolve(root, 'mainnet/0x3333333333333333333333333333333333333333/foo.zac.yaml');
    for (const flag of ['true', 'false']) {
      const { code, stderr } = await runCli(['plan', '--revoke-unmentioned', flag, src]);
      expect(code).not.toBe(0);
      expect(stderr).toContain('phase=validate');
      expect(stderr).toMatch(/config\/<name>\.zac\.yaml layout/);
    }
  });
});
