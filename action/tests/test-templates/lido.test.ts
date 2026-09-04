import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const UINT256_MAX =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

type RenderedFunction = {
  signature: string;
  execution_options: string;
  params?: unknown[];
};
type RenderedRole = { address: string; functions: RenderedFunction[] };

describe('lido/lido.tmpl', () => {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([TEMPLATES_DIR]), {
    throwOnUndefined: true,
  });
  env.addFilter('keccak', keccak);
  env.addGlobal('aliases', {
    ZERO,
    tokens: { WETH, stETH: STETH, wstETH: WSTETH },
  });

  const rolesOf = (params: Record<string, unknown> = {}): RenderedRole[] => {
    const doc = parseDocument(env.render('lido/lido.tmpl', params));
    expect(doc.errors).toEqual([]);
    return (doc.toJS() as { roles: RenderedRole[] }).roles;
  };

  const functionsAt = (roles: RenderedRole[], address: string): RenderedFunction[] => {
    const role = roles.find((r) => r.address === address);
    if (role === undefined) throw new Error(`no role scoped on ${address}`);
    return role.functions;
  };

  it('T11-1: renders with no params at all', () => {
    // The mint path is fixed by the protocol, so the template must not require any
    // `params:` block — a deployment has nothing to choose here.
    expect(() => env.render('lido/lido.tmpl', {})).not.toThrow();
  });

  it('T11-2: scopes the four calls on the right targets', () => {
    const roles = rolesOf();
    expect(functionsAt(roles, WETH).map((f) => f.signature)).toEqual([
      'function withdraw(uint256 amount)',
    ]);
    expect(functionsAt(roles, STETH).map((f) => f.signature)).toEqual([
      'function submit(address referral)',
      'function approve(address spender, uint256 amount)',
    ]);
    expect(functionsAt(roles, WSTETH).map((f) => f.signature)).toEqual([
      'function wrap(uint256 amount)',
    ]);
  });

  it('T11-3: submit is the only call granted the send execution option', () => {
    const withSend = rolesOf()
      .flatMap((r) => r.functions)
      .filter((f) => f.execution_options === 'send')
      .map((f) => f.signature);
    expect(withSend).toEqual(['function submit(address referral)']);
  });

  it('T11-4: the referral is pinned to the zero address', () => {
    const submit = functionsAt(rolesOf(), STETH).find((f) =>
      f.signature.startsWith('function submit'),
    );
    expect(submit?.params).toEqual([
      {
        name: 'referral',
        param_type: 'static',
        operator: 'equal_to',
        value: ZERO,
        value_type: 'address',
      },
    ]);
  });

  it('T11-5: the approve spender is pinned to the wrapper', () => {
    const out = env.render('lido/lido.tmpl', {});
    expect(out).toContain(`value: "${WSTETH}"`);
    expect(out).not.toContain('oneOf');
  });

  it('T11-6: max_approval defaults to uint256.max and is overridable', () => {
    expect(env.render('lido/lido.tmpl', {})).toContain(`value: "${UINT256_MAX}"`);
    expect(env.render('lido/lido.tmpl', { max_approval: '100000000000000000000' })).toContain(
      'value: "100000000000000000000"',
    );
  });

  it('T11-7: the reverse direction is not scoped', () => {
    // Exits go through a swap venue, scoped by its own template. If `unwrap` or a
    // withdrawal-queue call ever appears here, it is a scope change and wants a decision.
    const out = env.render('lido/lido.tmpl', {});
    expect(out).not.toContain('unwrap');
    expect(out).not.toContain('requestWithdrawals');
  });
});
