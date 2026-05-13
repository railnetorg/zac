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
 * `<network>/<safe-address>/<name>.zac.yaml` convention: the source lives
 * directly under `<network>/` (the old, pre-refactor layout). This lets us
 * verify which code path the CLI takes:
 *
 * - `findSafeDirs` (safe-dir mode, `--revoke-unmentioned=true`) throws
 *   `phase=validate` on the parent-dir layout check.
 * - `findGeneratedConfigs` (legacy mode, default `--revoke-unmentioned=false`) is
 *   layout-aware as well — both modes apply the same strict layout. So we
 *   verify the FLAG sources both go through layout validation by asserting
 *   `phase=validate` either way; the routing distinction surfaces in the
 *   error wording.
 */
function plantOldLayout(): string {
  const root = makeTempDir();
  const dir = join(root, 'mainnet');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'foo.zac.yaml'), '# x\n');
  writeFileSync(
    join(dir, 'foo.yaml'),
    `deployment:
  chain_id: 1
  safe_address: "0x3333333333333333333333333333333333333333"
  roles_modifier_address: "0x4444444444444444444444444444444444444444"
roles: {}
`,
  );
  return root;
}

describe('cli routing (dir vs file, --revoke-unmentioned)', () => {
  it('TS-40: dir-mode with `--revoke-unmentioned=true` rejects pre-refactor layout (`<network>/<file>.zac.yaml`) with `phase=validate`', async () => {
    const root = plantOldLayout();
    const { code, stderr } = await runCli(['plan', '--revoke-unmentioned', 'true', root]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('phase=validate');
    expect(stderr).toMatch(/configs\/<network>\/<safe-address>/);
  });

  it('TS-41: dir-mode with default flag (legacy mode) ALSO rejects the pre-refactor layout (same strict layout applies)', async () => {
    const root = plantOldLayout();
    const { code, stderr } = await runCli(['plan', root]);
    expect(code).not.toBe(0);
    // The legacy path goes through `findGeneratedConfigs`, which calls the
    // same layout validator.
    expect(stderr).toContain('phase=validate');
  });

  it('TS-42: file-mode honors the layout regardless of flag value', async () => {
    const root = plantOldLayout();
    const src = resolve(root, 'mainnet/foo.zac.yaml');
    for (const flag of ['true', 'false']) {
      const { code, stderr } = await runCli(['plan', '--revoke-unmentioned', flag, src]);
      expect(code).not.toBe(0);
      expect(stderr).toContain('phase=validate');
    }
  });
});
