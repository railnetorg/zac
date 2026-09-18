import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';
import { abiEncode } from '../../render/abiEncodeFilter';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

// CoW Milkman router + the UniV3 DynamicSlippageChecker this variant pins.
const MILKMAN = '0x060373D064d0168931dE2AB8DDA7410923d06E88';
const UNIV3_CHECKER = '0x2F965935f93718bB66d53a37a97080785657f0AC';
// The Chainlink checker milkman.tmpl pins — must NOT appear in this variant.
const CHAINLINK_CHECKER = '0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c';

const PENDLE = '0x808507121B80c02388fAd14726482e061B8da827';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const wstETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const UINT256_MAX =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

describe('milkman/milkman_univ3.tmpl', () => {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([TEMPLATES_DIR]), {
    throwOnUndefined: true,
  });
  env.addFilter('keccak', keccak);
  env.addFilter('abi_encode', abiEncode);
  env.addGlobal('aliases', {
    curator: { milkman: MILKMAN, univ3_price_checker: UNIV3_CHECKER },
    tokens: { PENDLE, WETH, wstETH, USDC },
  });

  // Mirrors the fork-test fixture: a multi-hop route and a single-hop route
  // with distinct caps and from-tokens. Fees are in BIPS (0.3% pool = 30).
  const params = {
    swaps: [
      { path: ['PENDLE', 'WETH', 'wstETH'], fees: [30, 1], max_slippage_bps: 200 },
      { path: ['WETH', 'USDC'], fees: [5], max_slippage_bps: 100 },
    ],
  };

  const render = (p: object = params): string => env.render('milkman/milkman_univ3.tmpl', p);

  it('TMU-1: renders without error', () => {
    expect(() => render()).not.toThrow();
  });

  it('TMU-2: rendered output parses + has approve + requestSwap signatures', () => {
    const out = render();
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    expect(out).toContain('function approve(address spender, uint256 amount)');
    expect(out).toContain(
      'function requestSwapExactTokensForTokens(uint256 amountIn, address fromToken, address toToken, address to, bytes32 appData, address priceChecker, bytes priceCheckerData)',
    );
  });

  it('TMU-3: approves cover each unique from-token (path[0]), spender == Milkman', () => {
    const out = render();
    const doc = parseDocument(out).toJSON() as { roles: Array<{ address: string }> };
    const targets = doc.roles.map((r) => r.address);
    // PENDLE and WETH approves + the Milkman target — wstETH/USDC are destinations only.
    expect(targets).toEqual([PENDLE, WETH, MILKMAN]);
    expect(out).toContain(`value: "${MILKMAN}"`); // spender == milkman
    expect(out).toContain(`value: "${UINT256_MAX}"`); // default ceiling (sentinel only)
  });

  it('TMU-3b: max_approval, when set, replaces the approve ceiling', () => {
    const out = render({ ...params, max_approval: '5000000000000000000000' }); // 5,000e18
    expect(out).toContain('value: "5000000000000000000000"');
    expect(out).not.toContain(`value: "${UINT256_MAX}"`);
  });

  it('TMU-3c: a repeated from-token yields a single approve target', () => {
    const out = render({
      swaps: [
        { path: ['PENDLE', 'WETH', 'wstETH'], fees: [30, 1], max_slippage_bps: 200 },
        { path: ['PENDLE', 'WETH'], fees: [30], max_slippage_bps: 100 },
      ],
    });
    const doc = parseDocument(out).toJSON() as { roles: Array<{ address: string }> };
    expect(doc.roles.map((r) => r.address)).toEqual([PENDLE, MILKMAN]);
  });

  it('TMU-4: requestSwap is an `or` of one `matches` branch per swap', () => {
    const out = render();
    expect(out).toContain('operator: "or"');
    expect((out.match(/operator: "matches"/g) ?? []).length).toBe(2);
  });

  it('TMU-5: every branch pins fromToken, toToken, to=avatar, and the UNIV3 checker', () => {
    const out = render();
    expect(out).toContain('operator: "equal_to_avatar"'); // to == avatar
    expect(out).toContain(`value: "${UNIV3_CHECKER}"`); // priceChecker pinned
    expect(out).not.toContain(CHAINLINK_CHECKER); // the variants don't cross-wire
    expect(out).toContain(`value: "${wstETH}"`); // toToken of swap 1
    expect(out).toContain(`value: "${USDC}"`); // toToken of swap 2
    // amountIn + appData are left free.
    expect(out).toContain('- name: amountIn');
    expect(out).toContain('- name: appData');
  });

  it('TMU-6: slippageBps is bounded per swap (cap + 1 as the less_than ceiling)', () => {
    const out = render();
    expect(out).toContain('value: "201"'); // PENDLE cap 200 → < 201
    expect(out).toContain('value: "101"'); // WETH cap 100 → < 101
  });

  it('TMU-7: innerData is PINNED (equal_to bytes) and matches abi.encode(swapPath, poolFees)', () => {
    const out = render();
    const doc = parseDocument(out).toJSON() as {
      roles: Array<{
        address: string;
        functions: Array<{ branches?: Array<{ params: Array<Record<string, unknown>> }> }>;
      }>;
    };
    const milkmanTarget = doc.roles.find((r) => r.address.toLowerCase() === MILKMAN.toLowerCase());
    const branches = milkmanTarget!.functions[0]!.branches!;
    expect(branches).toHaveLength(2);

    const innerDataOf = (branchIdx: number): Record<string, unknown> => {
      const pcd = branches[branchIdx]!.params.find((p) => p['name'] === 'priceCheckerData') as {
        children: Array<Record<string, unknown>>;
      };
      return pcd.children.find((c) => c['name'] === 'innerData')!;
    };

    const pendleInner = innerDataOf(0);
    expect(pendleInner['operator']).toBe('equal_to');
    expect(pendleInner['value_type']).toBe('bytes');
    expect(pendleInner['value']).toBe(
      abiEncode(
        [
          [PENDLE, WETH, wstETH],
          [30, 1],
        ],
        ['address[]', 'uint24[]'],
      ),
    );

    const wethInner = innerDataOf(1);
    expect(wethInner['operator']).toBe('equal_to');
    expect(wethInner['value']).toBe(abiEncode([[WETH, USDC], [5]], ['address[]', 'uint24[]']));
  });

  it('TMU-8: innerData carries a display_decode hint so `zac plan` can decode the blob', () => {
    const out = render();
    expect(out).toContain('display_decode');
    expect(out).toContain('{ name: swapPath, type: "address[]" }');
    expect(out).toContain('{ name: poolFees, type: "uint24[]" }');
  });

  it('TMU-9: cancelSwap is NOT scoped (cancellations go through the Safe UI)', () => {
    const out = render();
    expect(out).not.toContain('cancelSwap');
  });

  it('TMU-10: a fees list not one shorter than the path fails fast', () => {
    expect(() =>
      render({
        swaps: [{ path: ['PENDLE', 'WETH', 'wstETH'], fees: [30], max_slippage_bps: 200 }],
      }),
    ).toThrow();
  });

  it('TMU-11: a single-token path fails fast', () => {
    expect(() =>
      render({ swaps: [{ path: ['PENDLE'], fees: [], max_slippage_bps: 200 }] }),
    ).toThrow();
  });

  it('TMU-12: an unknown token alias key fails at render, not on-chain', () => {
    expect(() =>
      render({
        swaps: [{ path: ['PENDLE', 'NOT_A_TOKEN'], fees: [30], max_slippage_bps: 200 }],
      }),
    ).toThrow();
  });

  it('TMU-13: a QUOTED max_slippage_bps fails fast (nunjucks + would concat "200" → "2001", a 10× looser cap)', () => {
    expect(() =>
      render({
        swaps: [{ path: ['PENDLE', 'WETH', 'wstETH'], fees: [30, 1], max_slippage_bps: '200' }],
      }),
    ).toThrow();
  });

  it('TMU-14: a MISSING max_slippage_bps fails fast (would otherwise render NaN and only break at apply time)', () => {
    expect(() =>
      render({
        swaps: [{ path: ['PENDLE', 'WETH', 'wstETH'], fees: [30, 1] }],
      }),
    ).toThrow();
  });

  it('TMU-15: a fee in raw Uniswap units (3000) fails fast — fees must be UniV3 tiers in BIPS', () => {
    expect(() =>
      render({
        swaps: [{ path: ['PENDLE', 'WETH', 'wstETH'], fees: [3000, 100], max_slippage_bps: 200 }],
      }),
    ).toThrow();
  });

  it('TMU-16: a QUOTED fee ("30") fails fast — tier membership is checked with strict equality', () => {
    expect(() =>
      render({
        swaps: [{ path: ['PENDLE', 'WETH', 'wstETH'], fees: ['30', 1], max_slippage_bps: 200 }],
      }),
    ).toThrow();
  });

  it('TMU-17: fee 100 (the bips/raw-unit collision the guard cannot disambiguate) still renders — it IS the 1% tier in bips', () => {
    const out = render({
      swaps: [{ path: ['PENDLE', 'WETH', 'wstETH'], fees: [30, 100], max_slippage_bps: 200 }],
    });
    expect(out).toBe(out); // rendered without throwing; the pin is what matters
    expect(out).toContain(
      abiEncode(
        [
          [PENDLE, WETH, wstETH],
          [30, 100],
        ],
        ['address[]', 'uint24[]'],
      ),
    );
  });
});
