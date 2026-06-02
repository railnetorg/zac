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
  env.addGlobal('aliases', {
    aave: { pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
    tokens: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    },
  });

  const params = {
    deposit_assets: ['USDC', 'DAI'],
    emode_category: 0,
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
    expect(out).toContain(
      'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
    );
    expect(out).toContain(
      'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)',
    );
    expect(out).toContain('function setUserEMode(uint8 categoryId)');
  });

  it('T9-2b: borrow/repay pin interestRateMode to 2 and setUserEMode to emode_category', () => {
    const out = env.render('aave_v3/aave_v3.tmpl', { ...params, emode_category: 1 });
    // interestRateMode appears on both borrow and repay, each pinned to variable (2).
    expect(out.split('name: interestRateMode').length - 1).toBe(2);
    expect(out.match(/value: "2"/g)).toHaveLength(2);
    // setUserEMode categoryId pinned to the configured emode_category.
    expect(out).toContain('name: categoryId');
    expect(out).toContain('value: "1"');
  });

  it('T9-3: _macros/common.tmpl exposes approve(spender) for equal_to single spender', () => {
    const macroEnv = new nunjucks.Environment(new nunjucks.FileSystemLoader([TEMPLATES_DIR]), {
      throwOnUndefined: true,
    });
    const out = macroEnv.renderString(
      `{%- from "_macros/common.tmpl" import approve -%}\n{{ approve("0xToken", "0xSpender") }}`,
      {},
    );
    expect(out).toContain('- address: "0xToken"');
    expect(out).toContain('function approve(address spender, uint256 amount)');
    expect(out).toContain('operator: "equal_to"');
    expect(out).toContain('value: "0xSpender"');
    expect(out).not.toContain('oneOf');
  });

  it('T9-4: approve(spenders[]) emits oneOf over the list', () => {
    const macroEnv = new nunjucks.Environment(new nunjucks.FileSystemLoader([TEMPLATES_DIR]), {
      throwOnUndefined: true,
    });
    const out = macroEnv.renderString(
      `{%- from "_macros/common.tmpl" import approve -%}\n{{ approve("0xToken", ["0xA", "0xB"]) }}`,
      {},
    );
    expect(out).toContain('operator: "oneOf"');
    expect(out).toContain('- "0xA"');
    expect(out).toContain('- "0xB"');
    expect(out).not.toContain('operator: "equal_to"');
  });
});
