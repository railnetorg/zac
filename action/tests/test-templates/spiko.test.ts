import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SUBSCRIPTION = '0x2222222222222222222222222222222222222222';
const SUBSCRIPTION_2 = '0x3333333333333333333333333333333333333333';

interface Param {
  name: string;
  operator: string;
  values?: string[];
  value_type?: string;
}
interface Fn {
  signature: string;
  execution_options?: string;
  params?: Param[];
}
interface Rendered {
  roles: Array<{ address: string; functions: Fn[] }>;
}

describe('spiko/spiko.tmpl', () => {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader([resolve(REPO_ROOT, 'templates')]),
    { throwOnUndefined: true },
  );
  env.addFilter('keccak', keccak);
  env.addGlobal('aliases', { tokens: { USDC } });

  const params = {
    payment_asset: 'USDC',
    subscription_addresses: [SUBSCRIPTION, SUBSCRIPTION_2],
  };
  const render = (p: Record<string, unknown> = params) =>
    parseDocument(env.render('spiko/spiko.tmpl', p)).toJS() as Rendered;
  const paramNamed = (fn: Fn | undefined, name: string) => fn?.params?.find((p) => p.name === name);

  it('TS-1: renders without error and parses as YAML', () => {
    const out = env.render('spiko/spiko.tmpl', params);
    expect(parseDocument(out).errors).toEqual([]);
  });

  it('TS-2: a single target, the payment asset', () => {
    const { roles } = render();
    expect(roles.map((r) => r.address)).toEqual([USDC]);
  });

  it('TS-3: grants transfer only, recipient limited to subscription_addresses', () => {
    const [usdc] = render().roles;
    expect(usdc?.functions.map((f) => f.signature)).toEqual([
      'function transfer(address to, uint256 value)',
    ]);
    expect(paramNamed(usdc?.functions[0], 'to')).toMatchObject({
      operator: 'oneOf',
      values: [SUBSCRIPTION, SUBSCRIPTION_2],
      value_type: 'address',
    });
    expect(paramNamed(usdc?.functions[0], 'value')?.operator).toBe('pass');
  });

  it('TS-4: a single-entry list renders a one-value oneOf', () => {
    const [usdc] = render({ ...params, subscription_addresses: [SUBSCRIPTION] }).roles;
    expect(paramNamed(usdc?.functions[0], 'to')).toMatchObject({
      operator: 'oneOf',
      values: [SUBSCRIPTION],
      value_type: 'address',
    });
  });

  it('TS-5: the granted function forbids ETH value and delegatecall', () => {
    const [usdc] = render().roles;
    expect(usdc?.functions.map((f) => f.execution_options)).toEqual(['none']);
  });

  it('TS-6: unknown payment asset key fails at render time', () => {
    expect(() => env.render('spiko/spiko.tmpl', { ...params, payment_asset: 'NOPE' })).toThrow();
  });
});
