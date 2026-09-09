import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const POOL_USDC_A = '0xdA1000000000000000000000000000000000000a';
const POOL_USDC_B = '0xdA2000000000000000000000000000000000000b';
const POOL_WETH_A = '0xdA3000000000000000000000000000000000000c';

/**
 * `deposit_assets` is a list of `{asset, pool_alias}` entries, and the template's two
 * aggregation passes — the unique set of underlyings, then every pool sharing each one —
 * had no render coverage at all: the shipped example lists a single pool, so every test in
 * the repo took the single-element path.
 *
 * Rendered through `makeConfigEnv`, the builder the CLI itself uses, rather than a nunjucks
 * environment assembled here: a hand-built test env is how a filter comes to exist in
 * production and be missing in tests, or the reverse.
 */
describe('maple/maple.tmpl', () => {
  const env = makeConfigEnv({
    searchPaths: [TEMPLATES_DIR],
    aliases: {
      maple: { usdc_a: POOL_USDC_A, usdc_b: POOL_USDC_B, weth_a: POOL_WETH_A },
      tokens: { USDC, WETH },
    },
  });

  const render = (deposit_assets: Array<{ asset: string; pool_alias: string }>): string =>
    env.render('maple/maple.tmpl', { deposit_assets });

  /** The `roles[]` entries, as `{ address, functions }`, in emitted order. */
  const roles = (
    out: string,
  ): Array<{ address: string; functions: Array<{ signature: string }> }> => {
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    return (
      doc.toJSON() as { roles: Array<{ address: string; functions: Array<{ signature: string }> }> }
    ).roles;
  };

  /** The `spender` param of the approve role emitted for `token`. */
  const spenderParam = (out: string, token: string): Record<string, unknown> => {
    const role = roles(out).find((r) => r.address === token);
    expect(role, `no approve role for ${token}`).toBeDefined();
    const approve = role!.functions.find(
      (f) => f.signature === 'function approve(address spender, uint256 amount)',
    ) as unknown as { params: Array<Record<string, unknown>> };
    return approve.params.find((p) => p['name'] === 'spender')!;
  };

  it('TP-1: one pool — one approve role and one pool role', () => {
    const out = render([{ asset: 'USDC', pool_alias: 'usdc_a' }]);
    expect(roles(out).map((r) => r.address)).toEqual([USDC, POOL_USDC_A]);
    // Always a list into the shared macro, so even one spender takes the `oneOf` branch.
    expect(spenderParam(out, USDC)).toMatchObject({
      operator: 'oneOf',
      values: [POOL_USDC_A],
      value_type: 'address',
    });
  });

  it('TP-2: two pools on the SAME underlying — one approve role, both spenders', () => {
    // Two approve roles on one token would be a duplicate (address, signature) pair, which
    // the emit-phase merger rejects — so getting this wrong fails `generate` rather than
    // producing a loose policy.
    const out = render([
      { asset: 'USDC', pool_alias: 'usdc_a' },
      { asset: 'USDC', pool_alias: 'usdc_b' },
    ]);
    expect(roles(out).map((r) => r.address)).toEqual([USDC, POOL_USDC_A, POOL_USDC_B]);
    expect(spenderParam(out, USDC)).toMatchObject({ values: [POOL_USDC_A, POOL_USDC_B] });
  });

  it('TP-3: pools on DIFFERENT underlyings — one approve role per token', () => {
    const out = render([
      { asset: 'USDC', pool_alias: 'usdc_a' },
      { asset: 'WETH', pool_alias: 'weth_a' },
    ]);
    expect(roles(out).map((r) => r.address)).toEqual([USDC, WETH, POOL_USDC_A, POOL_WETH_A]);
    expect(spenderParam(out, USDC)).toMatchObject({ values: [POOL_USDC_A] });
    expect(spenderParam(out, WETH)).toMatchObject({ values: [POOL_WETH_A] });
  });

  it('TP-4: a repeated pool_alias collapses instead of emitting the pool twice', () => {
    // Without the dedup pass a repeat emits the pool's role block twice and fails `generate`
    // at the emit-phase merger — with a message naming a FUNCTION rather than the pool the
    // author actually repeated. It would also repeat the address in `oneOf`.
    const single = render([{ asset: 'USDC', pool_alias: 'usdc_a' }]);
    const out = render([
      { asset: 'USDC', pool_alias: 'usdc_a' },
      { asset: 'USDC', pool_alias: 'usdc_a' },
    ]);
    expect(roles(out).map((r) => r.address)).toEqual([USDC, POOL_USDC_A]);
    expect(out).toBe(single);
  });

  it('TP-5: dedup is on pool_alias, so a mismatched asset on a repeat cannot fork the role', () => {
    // A pool has exactly one underlying. Two entries naming one pool are the same grant
    // however `asset` is spelled, and the first spelling wins — so a typo in the second
    // entry cannot quietly add an approve role on an unrelated token.
    const out = render([
      { asset: 'USDC', pool_alias: 'usdc_a' },
      { asset: 'WETH', pool_alias: 'usdc_a' },
    ]);
    expect(roles(out).map((r) => r.address)).toEqual([USDC, POOL_USDC_A]);
  });

  it('TP-6: an unresolvable pool alias or asset throws rather than falling through', () => {
    expect(() => render([{ asset: 'USDC', pool_alias: 'nope' }])).toThrow();
    expect(() => render([{ asset: 'NOTATOKEN', pool_alias: 'usdc_a' }])).toThrow();
  });
});
