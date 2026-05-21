import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');

const VAULT_A = '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB';
const UNDERLYING_A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('metamorpho/metamorpho.tmpl', () => {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader([resolve(REPO_ROOT, 'templates')]),
    { throwOnUndefined: true },
  );
  env.addFilter('keccak', keccak);
  env.addGlobal('aliases', {
    metamorpho: {
      steakhouse_usdc: { address: VAULT_A, asset: 'USDC' },
    },
    tokens: { USDC: UNDERLYING_A },
  });

  const params = {
    vaults: ['steakhouse_usdc'],
  };

  it('TM-1: renders without error', () => {
    expect(() => env.render('metamorpho/metamorpho.tmpl', params)).not.toThrow();
  });

  it('TM-2: rendered output parses + has the 4 ERC-4626 functions + approve', () => {
    const out = env.render('metamorpho/metamorpho.tmpl', params);
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    expect(out).toContain('function approve(address spender, uint256 amount)');
    expect(out).toContain('function deposit(uint256 assets, address receiver)');
    expect(out).toContain('function mint(uint256 shares, address receiver)');
    expect(out).toContain('function withdraw(uint256 assets, address receiver, address owner)');
    expect(out).toContain('function redeem(uint256 shares, address receiver, address owner)');
  });

  it('TM-3: receiver/owner are pinned to avatar via equal_to_avatar', () => {
    const out = env.render('metamorpho/metamorpho.tmpl', params);
    // Count equal_to_avatar occurrences: receiver in deposit (1) + receiver in mint (1) +
    // receiver+owner in withdraw (2) + receiver+owner in redeem (2) = 6 per vault.
    const count = (out.match(/equal_to_avatar/g) ?? []).length;
    expect(count).toBe(6);
  });
});
