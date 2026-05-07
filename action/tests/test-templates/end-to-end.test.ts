import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { parseDocument } from 'yaml';

const execFileP = promisify(execFile);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const CLI = resolve(REPO_ROOT, 'action/cli.ts');
const EXAMPLE = resolve(REPO_ROOT, 'examples/mainnet/aave_safe.yaml');

describe('end-to-end AAVE V3', () => {
  it('T9-7: cli generate exits 0', async () => {
    const { stdout } = await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('T9-8: stdout contains both approve and supply signatures', async () => {
    const { stdout } = await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    expect(stdout).toContain('signature: function approve(address spender, uint256 amount)');
    expect(stdout).toContain(
      'signature: function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
    );
  });

  it('T9-9: aliases.aave.pool resolved (not placeholder)', async () => {
    const { stdout } = await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    expect(stdout).toContain('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
    expect(stdout).not.toContain('aliases.aave.pool');
  });

  it('T9-10: member addresses are present in members section', async () => {
    const { stdout } = await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    // The placeholder addresses are all-same-digit hex, so checksum equals lowercase.
    // Verify the members section contains the alice + bob addresses.
    expect(stdout).toMatch(/members:\n.*0x1111/s);
    expect(stdout).toMatch(/members:\n.*0x2222/s);
  });
});

describe('Phase 10 acceptance', () => {
  const GOLDEN = resolve(REPO_ROOT, 'action/tests/fixtures/golden/aave_safe.golden.yaml');
  const TMP_OUT = resolve(REPO_ROOT, 'action/tests/.tmp-out.yaml');

  it('T10-5: generate matches golden', async () => {
    if (existsSync(TMP_OUT)) unlinkSync(TMP_OUT);
    await execFileP('bun', [CLI, 'generate', EXAMPLE, '--out', TMP_OUT]);
    const actual = readFileSync(TMP_OUT, 'utf8');
    const expected = readFileSync(GOLDEN, 'utf8');
    expect(actual).toBe(expected);
    unlinkSync(TMP_OUT);
  });

  it('T10-6: re-running with --out overwrites silently', async () => {
    await execFileP('bun', [CLI, 'generate', EXAMPLE, '--out', TMP_OUT]);
    await execFileP('bun', [CLI, 'generate', EXAMPLE, '--out', TMP_OUT]);
    expect(existsSync(TMP_OUT)).toBe(true);
    unlinkSync(TMP_OUT);
  });

  it('T10-7: action.yml exists and declares using: composite', () => {
    const actionYml = readFileSync(resolve(REPO_ROOT, 'action/action.yml'), 'utf8');
    expect(actionYml).toMatch(/using:\s*composite/);
  });
});

describe('Phase 10 meta', () => {
  it('T10-1: action.yml is valid YAML', () => {
    const raw = readFileSync(resolve(REPO_ROOT, 'action/action.yml'), 'utf8');
    const doc = parseDocument(raw);
    expect(doc.errors).toEqual([]);
  });

  it('T10-2: action.yml declares using: composite', () => {
    const raw = readFileSync(resolve(REPO_ROOT, 'action/action.yml'), 'utf8');
    expect(raw).toMatch(/using:\s*composite/);
  });

  it('T10-3: root README contains required strings', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('bun run zac generate');
    expect(readme).toContain('https://www.notion.so/357c1910fb6e80a7b2b8f391ae421040');
  });

  it('T10-4: action/README.md references all 5 phases', () => {
    const readme = readFileSync(resolve(REPO_ROOT, 'action/README.md'), 'utf8');
    for (const phase of ['load', 'render', 'parse', 'validate', 'emit']) {
      expect(readme).toContain(phase);
    }
  });
});
