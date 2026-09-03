import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');

const VAULT = '0x30A3699E0dCEa6BDc8bb2C13e74a2324E0b20116';
const ASSET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC

describe('lagoon/lagoon.tmpl', () => {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader([resolve(REPO_ROOT, 'templates')]),
    { throwOnUndefined: true },
  );
  env.addFilter('keccak', keccak);
  // `asset` is a token alias KEY resolved via aliases.tokens[<key>].
  env.addGlobal('aliases', { tokens: { USDC: ASSET } });

  const params = { vault: VAULT, asset: 'USDC' };

  it('TL-1: renders without error', () => {
    expect(() => env.render('lagoon/lagoon.tmpl', params)).not.toThrow();
  });

  it('TL-2: rendered output parses + has approve + the 7 NAV functions', () => {
    const out = env.render('lagoon/lagoon.tmpl', params);
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    expect(out).toContain('function approve(address spender, uint256 amount)');
    expect(out).toContain('function updateNewTotalAssets(uint256 _newTotalAssets)');
    expect(out).toContain('function settleDeposit(uint256 _newTotalAssets)');
    expect(out).toContain('function settleRedeem(uint256 _newTotalAssets)');
    expect(out).toContain('function expireTotalAssets()');
    expect(out).toContain('function updateTotalAssetsLifespan(uint128 lifespan)');
    expect(out).toContain('function claimSharesOnBehalf(address[] controllers)');
    expect(out).toContain('function claimAssetsOnBehalf(address[] controllers)');
  });

  it('TL-3: approve targets the asset with spender pinned to the vault', () => {
    const out = env.render('lagoon/lagoon.tmpl', params);
    const doc = parseDocument(out).toJS() as {
      roles: Array<{
        address: string;
        functions: Array<{
          signature: string;
          params?: Array<{ name: string; operator: string; value?: string; value_type?: string }>;
        }>;
      }>;
    };

    // Exactly one approve role, and it lives on the ASSET token (not the vault).
    const approveRoles = doc.roles.filter((r) =>
      r.functions.some((f) => f.signature.startsWith('function approve(')),
    );
    expect(approveRoles).toHaveLength(1);
    expect(approveRoles[0]!.address.toLowerCase()).toBe(ASSET.toLowerCase());

    // spender is hard-scoped (equal_to) to the vault address; amount is pass.
    const approveFn = approveRoles[0]!.functions.find((f) =>
      f.signature.startsWith('function approve('),
    )!;
    const spender = approveFn.params!.find((p) => p.name === 'spender')!;
    expect(spender.operator).toBe('equal_to');
    expect(spender.value_type).toBe('address');
    expect((spender.value as string).toLowerCase()).toBe(VAULT.toLowerCase());
    const amount = approveFn.params!.find((p) => p.name === 'amount')!;
    expect(amount.operator).toBe('pass');

    // The NAV role lives on the vault and carries the seven settlement functions.
    const vaultRole = doc.roles.find((r) => r.address.toLowerCase() === VAULT.toLowerCase())!;
    expect(vaultRole.functions).toHaveLength(7);
  });

  it('TL-4: a missing asset throws (fail-fast — asset is required)', () => {
    expect(() => env.render('lagoon/lagoon.tmpl', { vault: VAULT })).toThrow();
  });

  it('TL-5: an asset key absent from the token registry throws (loud-fail)', () => {
    expect(() => env.render('lagoon/lagoon.tmpl', { vault: VAULT, asset: 'NOPE' })).toThrow();
  });
});
