import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
