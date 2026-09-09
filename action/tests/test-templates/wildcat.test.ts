import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MARKET_WETH_A = '0xBAd1b632E90Ce02af868f07c572adB067eB98353';
const MARKET_WETH_B = '0xBAd2000000000000000000000000000000000002';
const MARKET_USDC_A = '0xBAd3000000000000000000000000000000000003';

/**
 * The template's two passes — build the unique set of underlying token keys, then gather
 * every market sharing each underlying — are its only non-trivial logic, and both the
 * shipped example and the fork fixture list exactly one market. So every other test in
 * the repo takes the single-element path and this branch had no coverage at all.
 *
 * Rendering goes through `makeConfigEnv`, the builder the CLI itself uses, rather than a
 * nunjucks environment assembled here: a hand-built test env is how a filter comes to
 * exist in production and be missing in tests, or the reverse.
 */
describe('wildcat/wildcat.tmpl', () => {
  const env = makeConfigEnv({
    searchPaths: [TEMPLATES_DIR],
    aliases: {
      wildcat: {
        weth_a: { address: MARKET_WETH_A, asset: 'WETH' },
        weth_b: { address: MARKET_WETH_B, asset: 'WETH' },
        usdc_a: { address: MARKET_USDC_A, asset: 'USDC' },
      },
      tokens: { WETH, USDC },
    },
  });

  const render = (markets: string[]): string => env.render('wildcat/wildcat.tmpl', { markets });

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

  it('TW-1: one market — one approve role and one market role', () => {
    const out = render(['weth_a']);
    const emitted = roles(out);
    expect(emitted.map((r) => r.address)).toEqual([WETH, MARKET_WETH_A]);
    // Always a list into the shared macro, so even one spender takes the `oneOf` branch.
    expect(spenderParam(out, WETH)).toMatchObject({
      operator: 'oneOf',
      values: [MARKET_WETH_A],
      value_type: 'address',
    });
  });

  it('TW-2: two markets on the SAME underlying — one approve role, both spenders', () => {
    // The aggregation this branch exists for. Two approve roles on one token would be a
    // duplicate (address, signature) pair, which the emit-phase merger rejects — so
    // getting this wrong fails `generate` rather than producing a loose policy.
    const out = render(['weth_a', 'weth_b']);
    expect(roles(out).map((r) => r.address)).toEqual([WETH, MARKET_WETH_A, MARKET_WETH_B]);
    expect(spenderParam(out, WETH)).toMatchObject({
      operator: 'oneOf',
      values: [MARKET_WETH_A, MARKET_WETH_B],
    });
  });

  it('TW-3: two markets on DIFFERENT underlyings — one approve role per token', () => {
    const out = render(['weth_a', 'usdc_a']);
    expect(roles(out).map((r) => r.address)).toEqual([WETH, USDC, MARKET_WETH_A, MARKET_USDC_A]);
    expect(spenderParam(out, WETH)).toMatchObject({ values: [MARKET_WETH_A] });
    expect(spenderParam(out, USDC)).toMatchObject({ values: [MARKET_USDC_A] });
  });

  it('TW-4: three markets over two underlyings — grouped by underlying', () => {
    const out = render(['weth_a', 'usdc_a', 'weth_b']);
    // Approve roles come in first-seen order of the underlying, market roles in the order
    // the keys were listed.
    expect(roles(out).map((r) => r.address)).toEqual([
      WETH,
      USDC,
      MARKET_WETH_A,
      MARKET_USDC_A,
      MARKET_WETH_B,
    ]);
    expect(spenderParam(out, WETH)).toMatchObject({ values: [MARKET_WETH_A, MARKET_WETH_B] });
    expect(spenderParam(out, USDC)).toMatchObject({ values: [MARKET_USDC_A] });
  });

  it('TW-5: a duplicate key collapses instead of emitting the market twice', () => {
    // Without the dedup pass a repeat emits the market's role block twice and fails
    // `generate` at the emit-phase merger — with a message naming a FUNCTION rather than
    // the key the author actually repeated. It would also repeat the address in `oneOf`.
    const out = render(['weth_a', 'weth_a']);
    expect(roles(out).map((r) => r.address)).toEqual([WETH, MARKET_WETH_A]);
    expect(spenderParam(out, WETH)).toMatchObject({ values: [MARKET_WETH_A] });
    expect(out).toBe(render(['weth_a']));
  });

  it('TW-6: every market role carries the five lender grants and nothing else', () => {
    const marketRole = roles(render(['weth_a'])).find((r) => r.address === MARKET_WETH_A)!;
    expect(marketRole.functions.map((f) => f.signature)).toEqual([
      'function depositUpTo(uint256 amount)',
      'function deposit(uint256 amount)',
      'function queueWithdrawal(uint256 amount)',
      'function queueFullWithdrawal()',
      'function executeWithdrawal(address accountAddress, uint32 expiry)',
    ]);
  });

  it('TW-7: every emitted grant is execution_options "none"', () => {
    // The execution-mode axis, covered here rather than only on the fork side. The fork
    // suite asserts it behaviourally, but only for two of the six grants (deposit on the
    // market, approve on WETH), so widening any of the other four to `delegatecall` or
    // `both` left all 30 fork tests green. A delegatecall grant on the market is a total
    // compromise — it runs a 22kB contract carrying `borrow`, `closeMarket` and the rate
    // setters against the Safe's own storage — so this is asserted over EVERY emitted
    // function, and over any grant added later, instead of per hand-written case.
    // [markets, unique underlyings] — one approve grant per underlying, five per market.
    for (const [markets, assets] of [
      [['weth_a'], 1],
      [['weth_a', 'usdc_a', 'weth_b'], 2],
    ] as Array<[string[], number]>) {
      const emitted = roles(render(markets)) as unknown as Array<{
        address: string;
        functions: Array<{ signature: string; execution_options?: string }>;
      }>;
      const modes = emitted.flatMap((r) =>
        r.functions.map((f) => [`${r.address} ${f.signature}`, f.execution_options] as const),
      );
      expect(modes.length).toBe(assets + markets.length * 5);
      for (const [where, mode] of modes) {
        expect(mode, `${where} must be execution_options "none"`).toBe('none');
      }
    }
  });

  it('TW-8: an unresolvable market key or asset throws rather than falling through', () => {
    // The docstring's promise. `throwOnUndefined` is what delivers it.
    expect(() => render(['nope'])).toThrow();
    const envBadAsset = makeConfigEnv({
      searchPaths: [TEMPLATES_DIR],
      aliases: { wildcat: { x: { address: MARKET_WETH_A, asset: 'NOTATOKEN' } }, tokens: { WETH } },
    });
    expect(() => envBadAsset.render('wildcat/wildcat.tmpl', { markets: ['x'] })).toThrow();
  });
});
