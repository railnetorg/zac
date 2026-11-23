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

// CoW Milkman router + Chainlink DynamicSlippageChecker.
const MILKMAN = '0x060373D064d0168931dE2AB8DDA7410923d06E88';
const PRICE_CHECKER = '0xe80a1C615F75AFF7Ed8F08c9F21f9d00982D666c';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PYUSD = '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8';
const RLUSD = '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD';

// Aave PriceCapAdapterStable feeds (USDC/USD → dest/USD path).
const USDC_USD = '0x3f73F03aa83B2A48ed27E964eD0fDb590332095B';
const PYUSD_USD = '0x36964C0579D02E0a5AaAb89E24Cf8d7CDF3549EE';
const RLUSD_USD = '0xf0eaC18E908B34770FDEe46d069c846bDa866759';

const UINT256_MAX =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

describe('milkman/milkman.tmpl', () => {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([TEMPLATES_DIR]), {
    throwOnUndefined: true,
  });
  env.addFilter('keccak', keccak);
  env.addFilter('abi_encode', abiEncode);
  env.addGlobal('aliases', {
    curator: { milkman: MILKMAN, price_checker: PRICE_CHECKER },
    tokens: { USDC, PYUSD, RLUSD },
  });

  const buyPyusd = {
    from: 'USDC',
    to: 'PYUSD',
    max_slippage_bps: 500,
    feeds: [USDC_USD, PYUSD_USD],
    reverses: [false, true],
  };
  const buyRlusd = {
    from: 'USDC',
    to: 'RLUSD',
    max_slippage_bps: 700,
    feeds: [USDC_USD, RLUSD_USD],
    reverses: [false, true],
  };
  const sellPyusd = {
    from: 'PYUSD',
    to: 'USDC',
    max_slippage_bps: 300,
    feeds: [PYUSD_USD, USDC_USD],
    reverses: [false, true],
  };

  const params = { pairs: [buyPyusd, buyRlusd] };

  const render = (p: object = params): string => env.render('milkman/milkman.tmpl', p);

  it('TMK-1: renders without error', () => {
    expect(() => render()).not.toThrow();
  });

  it('TMK-2: rendered output parses + has approve + requestSwap signatures', () => {
    const out = render();
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    expect(out).toContain('function approve(address spender, uint256 amount)');
    expect(out).toContain(
      'function requestSwapExactTokensForTokens(uint256 amountIn, address fromToken, address toToken, address to, bytes32 appData, address priceChecker, bytes priceCheckerData)',
    );
  });

  it('TMK-3: approve pins spender == Milkman; amount ceiling defaults to uint256.max', () => {
    const out = render();
    expect(out).toContain(`value: "${MILKMAN}"`); // spender == milkman
    expect(out).toContain('operator: "less_than"');
    expect(out).toContain(`value: "${UINT256_MAX}"`); // default ceiling (sentinel only)
  });

  it('TMK-3b: max_approval, when set, replaces the approve ceiling', () => {
    const out = render({ ...params, max_approval: '20000000' }); // 20 USDC
    expect(out).toContain('value: "20000000"');
    expect(out).not.toContain(`value: "${UINT256_MAX}"`);
  });

  it('TMK-4: requestSwap is an `or` of one `matches` branch per pair', () => {
    const out = render();
    expect(out).toContain('operator: "or"');
    // 2 pairs = 2 branches.
    expect((out.match(/operator: "matches"/g) ?? []).length).toBe(2);
  });

  it('TMK-5: every branch pins fromToken, toToken, to=avatar, priceChecker', () => {
    const out = render();
    expect(out).toContain('operator: "equal_to_avatar"'); // to == avatar
    expect(out).toContain(`value: "${PRICE_CHECKER}"`); // priceChecker pinned
    expect(out).toContain(`value: "${PYUSD}"`); // toToken PYUSD branch
    expect(out).toContain(`value: "${RLUSD}"`); // toToken RLUSD branch
    // amountIn + appData are left free.
    expect(out).toContain('- name: amountIn');
    expect(out).toContain('- name: appData');
  });

  it('TMK-6: slippageBps is bounded per pair (cap + 1 as the less_than ceiling)', () => {
    const out = render();
    expect(out).toContain('value: "501"'); // PYUSD cap 500 → < 501
    expect(out).toContain('value: "701"'); // RLUSD cap 700 → < 701
  });

  it('TMK-7: innerData is PINNED (equal_to bytes), not free, and matches abi.encode(feeds, reverses)', () => {
    const out = render();
    const doc = parseDocument(out).toJSON() as {
      roles: Array<{
        address: string;
        functions: Array<{ branches?: Array<{ params: Array<Record<string, unknown>> }> }>;
      }>;
    };
    const milkmanTarget = doc.roles.find((r) => r.address.toLowerCase() === MILKMAN.toLowerCase());
    const branches = milkmanTarget!.functions[0]!.branches!;
    expect(branches).toHaveLength(2); // PYUSD, RLUSD

    const innerDataOf = (branchIdx: number): Record<string, unknown> => {
      const pcd = branches[branchIdx]!.params.find((p) => p['name'] === 'priceCheckerData') as {
        children: Array<Record<string, unknown>>;
      };
      return pcd.children.find((c) => c['name'] === 'innerData')!;
    };

    // PINNED, not the old vulnerable `operator: "pass"`.
    const pyusdInner = innerDataOf(0);
    expect(pyusdInner['operator']).toBe('equal_to');
    expect(pyusdInner['value_type']).toBe('bytes');
    expect(pyusdInner['value']).toBe(
      abiEncode(
        [
          [USDC_USD, PYUSD_USD],
          [false, true],
        ],
        ['address[]', 'bool[]'],
      ),
    );

    const rlusdInner = innerDataOf(1);
    expect(rlusdInner['operator']).toBe('equal_to');
    expect(rlusdInner['value']).toBe(
      abiEncode(
        [
          [USDC_USD, RLUSD_USD],
          [false, true],
        ],
        ['address[]', 'bool[]'],
      ),
    );
  });

  it('TMK-8: innerData carries a display_decode hint so `zac plan` can decode the blob', () => {
    const out = render();
    expect(out).toContain('display_decode');
    expect(out).toContain('{ name: feeds, type: "address[]" }');
    expect(out).toContain('{ name: reverses, type: "bool[]" }');
  });

  it('TMK-9: cancelSwap is NOT scoped (cancellations go through the Safe UI)', () => {
    const out = render();
    expect(out).not.toContain('cancelSwap');
  });

  it('TMK-10: a pair missing its feeds/reverses fails fast (throwOnUndefined)', () => {
    expect(() =>
      render({ pairs: [{ from: 'USDC', to: 'PYUSD', max_slippage_bps: 500 }] }),
    ).toThrow();
  });

  it('TMK-11: a QUOTED max_slippage_bps fails fast (nunjucks + would concat "500" → "5001", a 10× looser cap)', () => {
    expect(() => render({ pairs: [{ ...buyPyusd, max_slippage_bps: '500' }] })).toThrow();
  });

  it('TMK-12: a MISSING max_slippage_bps fails fast (would otherwise render NaN and only break at apply time)', () => {
    expect(() =>
      render({
        pairs: [
          { from: 'USDC', to: 'PYUSD', feeds: [USDC_USD, PYUSD_USD], reverses: [false, true] },
        ],
      }),
    ).toThrow();
  });

  it('TMK-13: pairs in both directions — one approve per distinct from token, one branch per pair', () => {
    const out = render({ pairs: [buyPyusd, buyRlusd, sellPyusd] });
    const doc = parseDocument(out).toJSON() as {
      roles: Array<{
        address: string;
        functions: Array<{ signature: string; branches?: unknown[] }>;
      }>;
    };
    const approveTargets = doc.roles
      .filter((r) => r.functions[0]!.signature.startsWith('function approve'))
      .map((r) => r.address);
    expect(approveTargets).toEqual([USDC, PYUSD]); // USDC once, in order of first use
    const milkmanTarget = doc.roles.find((r) => r.address.toLowerCase() === MILKMAN.toLowerCase());
    expect(milkmanTarget!.functions[0]!.branches).toHaveLength(3);
  });

  it('TMK-14: a sell pair pins its own feed path and cap, distinct from the buy pair on the same tokens', () => {
    const out = render({ pairs: [buyPyusd, sellPyusd] });
    const doc = parseDocument(out).toJSON() as {
      roles: Array<{
        address: string;
        functions: Array<{ branches?: Array<{ params: Array<Record<string, unknown>> }> }>;
      }>;
    };
    const milkmanTarget = doc.roles.find((r) => r.address.toLowerCase() === MILKMAN.toLowerCase());
    const sell = milkmanTarget!.functions[0]!.branches![1]!;
    const param = (name: string) => sell.params.find((p) => p['name'] === name)!;
    expect(param('fromToken')['value']).toBe(PYUSD);
    expect(param('toToken')['value']).toBe(USDC);
    const children = (param('priceCheckerData') as { children: Array<Record<string, unknown>> })
      .children;
    expect(children.find((c) => c['name'] === 'slippageBps')!['value']).toBe('301');
    expect(children.find((c) => c['name'] === 'innerData')!['value']).toBe(
      abiEncode(
        [
          [PYUSD_USD, USDC_USD],
          [false, true],
        ],
        ['address[]', 'bool[]'],
      ),
    );
  });

  it('TMK-15: a duplicated (from, to) pair fails fast', () => {
    expect(() => render({ pairs: [buyPyusd, { ...buyPyusd, max_slippage_bps: 100 }] })).toThrow();
  });

  it('TMK-16: a pair with from == to fails fast', () => {
    expect(() => render({ pairs: [{ ...buyPyusd, to: 'USDC' }] })).toThrow();
  });

  it('TMK-17: feeds and reverses of different lengths fail fast', () => {
    expect(() => render({ pairs: [{ ...buyPyusd, reverses: [false] }] })).toThrow();
  });

  it('TMK-18: empty feeds fail fast', () => {
    expect(() => render({ pairs: [{ ...buyPyusd, feeds: [], reverses: [] }] })).toThrow();
  });

  it('TMK-19: a missing or empty pairs list fails fast', () => {
    expect(() => render({})).toThrow();
    expect(() => render({ pairs: [] })).toThrow();
  });
});
