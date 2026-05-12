import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

describe('aave_v3/aave_v3.tmpl', () => {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([TEMPLATES_DIR]), {
    throwOnUndefined: true,
  });
  env.addFilter('keccak', keccak);

  const params = {
    pool_address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    deposit_assets: [
      { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC' },
      { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI' },
    ],
  };

  it('T9-1: renders without error', () => {
    expect(() => env.render('aave_v3/aave_v3.tmpl', params)).not.toThrow();
  });

  it('T9-2: rendered output parses + has expected rules', () => {
    const out = env.render('aave_v3/aave_v3.tmpl', params);
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    expect(out).toContain('function approve(address spender, uint256 amount)');
    expect(out).toContain(
      'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
    );
    expect(out).toContain('function withdraw(address asset, uint256 amount, address onBehalfOf)');
  });

  it('T9-3: _macros/common.tmpl is importable + macro produces expected output', () => {
    const macroEnv = new nunjucks.Environment(new nunjucks.FileSystemLoader([TEMPLATES_DIR]), {
      throwOnUndefined: true,
    });
    const out = macroEnv.renderString(
      `{%- from "_macros/common.tmpl" import addr_with_comment -%}\n{{ addr_with_comment("0xabc", "Alice") }}`,
      {},
    );
    expect(out).toContain('"0xabc"');
    expect(out).toContain('# Alice');
  });
});
