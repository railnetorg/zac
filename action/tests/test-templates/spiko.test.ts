import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';
import { validateRenderedTemplate } from '../../validate/runValidate';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USTBL = '0xe4880249745eAc5F1eD9d8F7DF844792D560e750';
const SAFO = '0xcBaDe7D9BdEe88411CB6cbCbB29952b742036992';
const MULTI_ATM = '0xBD6AD96f51E8d732811587468d0E2F9EFa55f605';
const REDEMPTION = '0xDA5599f04e9b437C8394b0c2BC68B502A66ebFe8';
const SUBSCRIPTION = '0x2222222222222222222222222222222222222222';
const SUBSCRIPTION_2 = '0x3333333333333333333333333333333333333333';

interface Param {
  name: string;
  param_type?: string;
  operator?: string;
  value?: string;
  values?: string[];
  value_type?: string;
  children?: Param[];
}
interface Fn {
  signature: string;
  execution_options?: string;
  params?: Param[];
}
interface Role {
  address: string;
  functions: Fn[];
}
interface Rendered {
  roles: Role[];
}

describe('spiko/spiko.tmpl', () => {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader([resolve(REPO_ROOT, 'templates')]),
    { throwOnUndefined: true },
  );
  env.addFilter('keccak', keccak);
  env.addGlobal('aliases', {
    tokens: { USDC },
    spiko: { multi_atm: MULTI_ATM, redemption: REDEMPTION, funds: { USTBL, SAFO } },
  });

  const atm = {
    payment_asset: 'USDC',
    subscription_addresses: [SUBSCRIPTION, SUBSCRIPTION_2],
    fund: 'USTBL',
    redeem_via: 'multi_atm',
  };
  const request = { ...atm, fund: 'SAFO', redeem_via: 'redemption_request' };
  const render = (p: Record<string, unknown>) =>
    parseDocument(env.render('spiko/spiko.tmpl', p)).toJS() as Rendered;
  const roleAt = (r: Rendered, address: string) => r.roles.find((x) => x.address === address);
  const paramNamed = (fn: Fn | undefined, name: string) => fn?.params?.find((p) => p.name === name);
  const allFns = (r: Rendered) => r.roles.flatMap((x) => x.functions);

  it('TS-1: both routes render, parse as YAML and pass validation', () => {
    for (const p of [atm, request]) {
      const out = env.render('spiko/spiko.tmpl', p);
      expect(parseDocument(out).errors).toEqual([]);
      const { roles } = parseDocument(out).toJS() as Parameters<typeof validateRenderedTemplate>[0];
      expect(() =>
        validateRenderedTemplate({ templatePath: 'spiko/spiko.tmpl', roles }),
      ).not.toThrow();
    }
  });

  it('TS-2: subscription grants transfer only, recipient limited to subscription_addresses', () => {
    for (const p of [atm, request]) {
      const usdc = roleAt(render(p), USDC);
      expect(usdc?.functions.map((f) => f.signature)).toEqual([
        'function transfer(address to, uint256 value)',
      ]);
      expect(paramNamed(usdc?.functions[0], 'to')).toMatchObject({
        operator: 'oneOf',
        values: [SUBSCRIPTION, SUBSCRIPTION_2],
        value_type: 'address',
      });
      expect(paramNamed(usdc?.functions[0], 'value')?.operator).toBe('pass');
    }
  });

  it('TS-3: a single-entry list renders a one-value oneOf', () => {
    const usdc = roleAt(render({ ...atm, subscription_addresses: [SUBSCRIPTION] }), USDC);
    expect(paramNamed(usdc?.functions[0], 'to')).toMatchObject({
      operator: 'oneOf',
      values: [SUBSCRIPTION],
    });
  });

  it('TS-4: multi_atm targets the payment asset, the fund and the ATM, nothing else', () => {
    expect(render(atm).roles.map((r) => r.address)).toEqual([USDC, USTBL, MULTI_ATM]);
  });

  it('TS-5: multi_atm approves the fund to the ATM only', () => {
    const fund = roleAt(render(atm), USTBL);
    expect(fund?.functions.map((f) => f.signature)).toEqual([
      'function approve(address spender, uint256 amount)',
    ]);
    expect(paramNamed(fund?.functions[0], 'spender')).toMatchObject({
      operator: 'equal_to',
      value: MULTI_ATM,
      value_type: 'address',
    });
  });

  it('TS-6: multi_atm swaps fund → payment asset only, paid to the Safe', () => {
    const swap = roleAt(render(atm), MULTI_ATM);
    expect(swap?.functions.map((f) => f.signature)).toEqual([
      'function swapExactInputSingle(address input, address output, uint256 inputAmount, address recipient, uint256 minOutputAmount)',
    ]);
    const fn = swap?.functions[0];
    expect(paramNamed(fn, 'input')).toMatchObject({ operator: 'equal_to', value: USTBL });
    expect(paramNamed(fn, 'output')).toMatchObject({ operator: 'equal_to', value: USDC });
    expect(paramNamed(fn, 'recipient')?.operator).toBe('equal_to_avatar');
    expect(paramNamed(fn, 'inputAmount')?.operator).toBe('pass');
    expect(paramNamed(fn, 'minOutputAmount')?.operator).toBe('pass');
  });

  it('TS-7: redemption_request targets the payment asset and the fund, nothing else', () => {
    expect(render(request).roles.map((r) => r.address)).toEqual([USDC, SAFO]);
  });

  it('TS-8: redemption_request sends the fund to Redemption with output pinned to the payment asset', () => {
    const fund = roleAt(render(request), SAFO);
    expect(fund?.functions.map((f) => f.signature)).toEqual([
      'function transferAndCall(address to, uint256 value, bytes data)',
    ]);
    const fn = fund?.functions[0];
    expect(paramNamed(fn, 'to')).toMatchObject({ operator: 'equal_to', value: REDEMPTION });
    expect(paramNamed(fn, 'value')?.operator).toBe('pass');
    expect(paramNamed(fn, 'data')).toEqual({
      name: 'data',
      param_type: 'abi_encoded',
      children: [
        {
          name: 'output',
          param_type: 'static',
          operator: 'equal_to',
          value: USDC,
          value_type: 'address',
        },
        { name: 'salt', param_type: 'static', operator: 'pass', value_type: 'bytes32' },
      ],
    });
  });

  it('TS-9: every granted function forbids ETH value and delegatecall', () => {
    for (const p of [atm, request]) {
      expect(new Set(allFns(render(p)).map((f) => f.execution_options))).toEqual(new Set(['none']));
    }
  });

  it('TS-10: unknown payment asset key fails at render time', () => {
    expect(() => env.render('spiko/spiko.tmpl', { ...atm, payment_asset: 'NOPE' })).toThrow();
  });

  it('TS-11: unknown fund key fails at render time, on both routes', () => {
    for (const p of [atm, request]) {
      expect(() => env.render('spiko/spiko.tmpl', { ...p, fund: 'NOPE' })).toThrow();
    }
  });

  it('TS-12: redeem_via is required and limited to the two routes', () => {
    const { redeem_via: _omit, ...missing } = atm;
    void _omit;
    expect(() => env.render('spiko/spiko.tmpl', missing)).toThrow();
    expect(() => env.render('spiko/spiko.tmpl', { ...atm, redeem_via: 'api' })).toThrow();
  });
});
