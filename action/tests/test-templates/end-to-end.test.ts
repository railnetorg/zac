import { describe, it, expect, afterEach } from 'vitest';
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
const EXAMPLE = resolve(REPO_ROOT, 'examples/mainnet/aave_safe.zac.yaml');
const GENERATED = resolve(REPO_ROOT, 'examples/mainnet/aave_safe.yaml');

function cleanGenerated(): void {
  if (existsSync(GENERATED)) unlinkSync(GENERATED);
}

describe('end-to-end AAVE V3', () => {
  afterEach(cleanGenerated);

  it('T9-7: cli generate exits 0 and writes alongside', async () => {
    const { stdout } = await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    expect(stdout).toContain('generated:');
    expect(existsSync(GENERATED)).toBe(true);
  });

  it('T9-8: generated file contains both approve and supply signatures', async () => {
    await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    const out = readFileSync(GENERATED, 'utf8');
    expect(out).toContain('signature: function approve(address spender, uint256 amount)');
    expect(out).toContain(
      'signature: function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
    );
  });

  it('T9-9: aliases.aave.pool resolved (not placeholder)', async () => {
    await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    const out = readFileSync(GENERATED, 'utf8');
    expect(out).toContain('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
    expect(out).not.toContain('aliases.aave.pool');
  });

  it('T9-10: member addresses are present in members section', async () => {
    await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    const out = readFileSync(GENERATED, 'utf8');
    // The placeholder addresses are all-same-digit hex, so checksum equals lowercase.
    // Verify the members section contains the alice + bob addresses.
    expect(out).toMatch(/members:\n.*0x1111/s);
    expect(out).toMatch(/members:\n.*0x2222/s);
  });
});

describe('Phase 10 acceptance', () => {
  const GOLDEN = resolve(REPO_ROOT, 'action/tests/fixtures/golden/aave_safe.golden.yaml');

  afterEach(cleanGenerated);

  it('T10-5: generate matches golden', async () => {
    await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    const actual = readFileSync(GENERATED, 'utf8');
    const expected = readFileSync(GOLDEN, 'utf8');
    expect(actual).toBe(expected);
  });

  it('T10-6: re-running generate overwrites silently', async () => {
    await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    await execFileP('bun', [CLI, 'generate', EXAMPLE]);
    expect(existsSync(GENERATED)).toBe(true);
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
