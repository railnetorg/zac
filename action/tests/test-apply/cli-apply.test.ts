import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-cli-apply-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Plant a valid layout `<root>/mainnet/<safeAddress>/foo.zac.yaml` (plus
 * sibling generated `foo.yaml` when `writeGenerated=true`). Returns the
 * source absolute path.
 */
function plantSafeDirSource(opts: { writeGenerated: boolean }): { root: string; src: string } {
  const root = makeTempDir();
  const safe = '0x3333333333333333333333333333333333333333';
  const dir = join(root, 'mainnet', safe);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'foo.zac.yaml');
  writeFileSync(src, '# x\n');
  if (opts.writeGenerated) {
    writeFileSync(
      join(dir, 'foo.yaml'),
      `deployment:
  chain_id: 1
  safe_address: "${safe}"
  roles_modifier_address: "0x4444444444444444444444444444444444444444"
roles: {}
`,
    );
  }
  return { root, src };
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

  it('T11-19: apply <nonexistent> exits 1 with phase= in stderr', async () => {
    // Strip ZAC_PROPOSER_PRIVATE_KEY from env so the parse/discovery error
    // surfaces (or the missing-key error does). Discovery errors now surface
    // as phase=load when the path doesn't exist.
    const env = { ...process.env };
    delete env['ZAC_PROPOSER_PRIVATE_KEY'];
    const { code, stderr } = await runCli(['apply', '/definitely/does/not/exist.yaml'], env);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=');
  });

  it('T11-20: README documents zac apply + ZAC_PROPOSER_PRIVATE_KEY', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('zac apply');
    expect(readme).toContain('ZAC_PROPOSER_PRIVATE_KEY');
  });

  it('T11-21: apply <foo.zac.yaml> WITHOUT a generated sibling → phase=load friendly "run `zac generate` first"', async () => {
    // File-mode: source exists, sibling .yaml is missing. The error must
    // mirror the safe-dir mode wording so users get the same hint.
    const { src } = plantSafeDirSource({ writeGenerated: false });
    const env = { ...process.env };
    env['ZAC_PROPOSER_PRIVATE_KEY'] =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const { code, stderr } = await runCli(['plan', src], env);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=load');
    expect(stderr).toContain('missing generated config');
    expect(stderr).toContain('zac generate');
  });

  it('T11-22: apply with NO ZAC_PROPOSER_PRIVATE_KEY pre-checks once (not N times)', async () => {
    // Plant a valid dir-mode layout with one safe-dir; the env-var check
    // must surface ONCE at the top of the apply action, not per-safe-dir.
    const { root } = plantSafeDirSource({ writeGenerated: true });
    const env = { ...process.env };
    delete env['ZAC_PROPOSER_PRIVATE_KEY'];
    const { code, stderr } = await runCli(['apply', root], env);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=apply');
    expect(stderr).toContain('ZAC_PROPOSER_PRIVATE_KEY');
    // The pre-check fires before any safe-dir batch entry, so there's no
    // per-safe `safe=…` prefix in the output.
    expect(stderr).not.toContain('safe=');
  });

  it('T11-23: plan <foo.zac.yaml> --revoke-unmentioned=true (file-mode) emits WARN about no-op', async () => {
    const { src } = plantSafeDirSource({ writeGenerated: false });
    // No generated file → the run will fail with phase=load, but the WARN
    // must appear on stderr BEFORE the error (warning is emitted during
    // routing, the load error fires when we try to resolve generated).
    const { code, stderr } = await runCli(['plan', '--revoke-unmentioned', 'true', src]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('WARN: --revoke-unmentioned has no effect in file-mode');
  });

  it('T11-24: plan <foo.zac.yaml> with default flag (no explicit pass) does NOT warn', async () => {
    const { src } = plantSafeDirSource({ writeGenerated: false });
    const { code, stderr } = await runCli(['plan', src]);
    expect(code).not.toBe(0);
    expect(stderr).not.toContain('WARN: --revoke-unmentioned has no effect');
  });

  it('T11-25: plan <foo.zac.yaml> --revoke-unmentioned=false (explicit false) does NOT warn', async () => {
    const { src } = plantSafeDirSource({ writeGenerated: false });
    const { code, stderr } = await runCli(['plan', '--revoke-unmentioned', 'false', src]);
    expect(code).not.toBe(0);
    expect(stderr).not.toContain('WARN: --revoke-unmentioned has no effect');
  });

  it('T11-26: plan with a generated .yaml file directly → phase=load suggesting the .zac.yaml', async () => {
    // The CLI surface is uniform: users always pass .zac.yaml sources.
    // Passing the generated .yaml directly must be rejected with a clear
    // hint pointing to the source.
    const { src } = plantSafeDirSource({ writeGenerated: true });
    const generated = src.slice(0, -'.zac.yaml'.length) + '.yaml';
    const { code, stderr } = await runCli(['plan', generated]);
    expect(code).toBe(1);
    expect(stderr).toContain('phase=load');
    expect(stderr).toContain('.zac.yaml');
  });
});
