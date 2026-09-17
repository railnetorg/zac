import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');

const VAULT = '0x30A3699E0dCEa6BDc8bb2C13e74a2324E0b20116';
const ASSET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC

describe('lagoon/lagoon.tmpl', () => {
  // The production environment builder, so the `bool` filter the template relies
  // on is the one the CLI registers. `asset` is a token alias KEY resolved via
  // aliases.tokens[<key>].
  const env = makeConfigEnv({
    searchPaths: [resolve(REPO_ROOT, 'templates')],
    aliases: { tokens: { USDC: ASSET } },
  });

  const params = { vault: VAULT, asset: 'USDC', safe_is_valuation_manager: true };
  const signatures = (out: string) =>
    [...out.matchAll(/signature: "function (\w+)\(/g)].map((m) => m[1]);

  it('TL-1: renders without error', () => {
    expect(() => env.render('lagoon/lagoon.tmpl', params)).not.toThrow();
  });

  it('TL-2: safe_is_valuation_manager=true renders approve + the 6 vault functions', () => {
    const out = env.render('lagoon/lagoon.tmpl', params);
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    expect(out).toContain('function approve(address spender, uint256 amount)');
    expect(out).toContain('function updateNewTotalAssets(uint256 _newTotalAssets)');
    expect(out).toContain('function settleDeposit(uint256 _newTotalAssets)');
    expect(out).toContain('function settleRedeem(uint256 _newTotalAssets)');
    expect(out).toContain('function expireTotalAssets()');
    expect(out).toContain('function claimSharesOnBehalf(address[] controllers)');
    expect(out).toContain('function claimAssetsOnBehalf(address[] controllers)');
    // Not granted: activating async-only zeroes the totalAssets lifespan and shuts
    // the setter, so the call reverts `AsyncOnly()` from any caller for the life of
    // the vault. Asserted absent so it cannot come back as unexercisable authority.
    expect(out).not.toContain('updateTotalAssetsLifespan');
  });

  it('TL-2b: safe_is_valuation_manager=false leaves out updateNewTotalAssets only', () => {
    const out = env.render('lagoon/lagoon.tmpl', { ...params, safe_is_valuation_manager: false });
    expect(parseDocument(out).errors).toEqual([]);
    expect(signatures(out)).toEqual([
      'approve',
      'settleDeposit',
      'settleRedeem',
      'expireTotalAssets',
      'claimSharesOnBehalf',
      'claimAssetsOnBehalf',
    ]);
    expect(out).toContain('# safe_is_valuation_manager: false');
  });

  it('TL-2c: omitting safe_is_valuation_manager throws rather than defaulting', () => {
    expect(() => env.render('lagoon/lagoon.tmpl', { vault: VAULT, asset: 'USDC' })).toThrow();
  });

  it('TL-2d: a quoted safe_is_valuation_manager is rejected', () => {
    for (const v of ['false', 'true', '0', 'no']) {
      expect(() =>
        env.render('lagoon/lagoon.tmpl', { ...params, safe_is_valuation_manager: v }),
      ).toThrow(/must be a YAML boolean/);
    }
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

    // The NAV role lives on the vault and carries the six settlement functions.
    const vaultRole = doc.roles.find((r) => r.address.toLowerCase() === VAULT.toLowerCase())!;
    expect(vaultRole.functions).toHaveLength(6);
  });

  it('TL-4: a missing asset throws (fail-fast — asset is required)', () => {
    expect(() => env.render('lagoon/lagoon.tmpl', { vault: VAULT })).toThrow();
  });

  it('TL-5: an asset key absent from the token registry throws (loud-fail)', () => {
    expect(() => env.render('lagoon/lagoon.tmpl', { vault: VAULT, asset: 'NOPE' })).toThrow();
  });
});
