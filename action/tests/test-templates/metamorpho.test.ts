import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');

const VAULT_A = '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB';
const VAULT_B = '0xBEEF020000000000000000000000000000000002';
const UNDERLYING_A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('metamorpho/metamorpho.tmpl', () => {
  // Rendered through `makeConfigEnv`, the builder the CLI itself uses, rather than a
  // nunjucks environment assembled here: a hand-built test env is how a filter comes to
  // exist in production and be missing in tests, or the reverse. (This file used to build
  // its own and registered only `keccak`, while the CLI also registers `abi_encode` and
  // `bool`.)
  const env = makeConfigEnv({
    searchPaths: [resolve(REPO_ROOT, 'templates')],
    aliases: {
      metamorpho: {
        steakhouse_usdc: { address: VAULT_A, asset: 'USDC' },
        gauntlet_usdc_core: { address: VAULT_B, asset: 'USDC' },
      },
      tokens: { USDC: UNDERLYING_A },
    },
  });

  const params = {
    vaults: ['steakhouse_usdc'],
  };

  /** The `roles[]` target addresses, in emitted order. */
  const targets = (out: string): string[] =>
    (parseDocument(out).toJSON() as { roles: Array<{ address: string }> }).roles.map(
      (r) => r.address,
    );

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

  it('TM-4: two vaults on the same underlying — one approve role, both spenders', () => {
    const out = env.render('metamorpho/metamorpho.tmpl', {
      vaults: ['steakhouse_usdc', 'gauntlet_usdc_core'],
    });
    expect(targets(out)).toEqual([UNDERLYING_A, VAULT_A, VAULT_B]);
  });

  it('TM-5: a duplicate key collapses instead of emitting the vault twice', () => {
    // Without the dedup pass a repeat emits the vault's role block twice and fails
    // `generate` at the emit-phase merger — with a message naming a FUNCTION rather than
    // the key the author actually repeated. It would also repeat the address in `oneOf`.
    const out = env.render('metamorpho/metamorpho.tmpl', {
      vaults: ['steakhouse_usdc', 'steakhouse_usdc'],
    });
    expect(targets(out)).toEqual([UNDERLYING_A, VAULT_A]);
    expect(out).toBe(env.render('metamorpho/metamorpho.tmpl', params));
  });
});
