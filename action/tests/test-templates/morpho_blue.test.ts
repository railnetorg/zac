import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

const SINGLETON = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const ORACLE_A = '0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2';
const ORACLE_B = '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a';
const IRM = '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC';
const LLTV = '860000000000000000';

type Condition = { operator: string; value?: string; conditions?: Condition[] };
type Param = { name: string; operator?: string; value?: string; conditions?: Condition[] };
type RenderedFunction = { signature: string; params: Param[] };
type RenderedRole = { address: string; functions: RenderedFunction[] };

describe('morpho_blue/morpho_blue.tmpl', () => {
  // The production environment builder, not a hand-rolled one: a filter registered
  // for the CLI has to be present here too, or a template can pass its tests and fail
  // when rendered for real (or the reverse).
  const env = makeConfigEnv({
    searchPaths: [TEMPLATES_DIR],
    aliases: {
      morpho_blue: {
        singleton: SINGLETON,
        markets: {
          usdc_wsteth_86: {
            loan_token: USDC,
            collateral_token: WSTETH,
            oracle: ORACLE_A,
            irm: IRM,
            lltv: LLTV,
          },
          usdc_cbbtc_86: {
            loan_token: USDC,
            collateral_token: CBBTC,
            oracle: ORACLE_B,
            irm: IRM,
            lltv: LLTV,
          },
          // Loan token equals the other market's collateral, to exercise approve dedup.
          wsteth_cbbtc_86: {
            loan_token: WSTETH,
            collateral_token: CBBTC,
            oracle: ORACLE_B,
            irm: IRM,
            lltv: LLTV,
          },
        },
      },
    },
  });

  const rolesOf = (markets: string[], borrow = true): RenderedRole[] => {
    const doc = parseDocument(env.render('morpho_blue/morpho_blue.tmpl', { markets, borrow }));
    expect(doc.errors).toEqual([]);
    return (doc.toJS() as { roles: RenderedRole[] }).roles;
  };

  const singletonFunctions = (markets: string[], borrow = true): RenderedFunction[] => {
    const role = rolesOf(markets, borrow).find((r) => r.address === SINGLETON);
    if (role === undefined) throw new Error('no role scoped on the singleton');
    return role.functions;
  };

  const paramOf = (fn: RenderedFunction, name: string): Param => {
    const p = fn.params.find((x) => x.name === name);
    if (p === undefined) throw new Error(`${fn.signature} has no param ${name}`);
    return p;
  };

  const fnNamed = (fns: RenderedFunction[], name: string): RenderedFunction => {
    const fn = fns.find((f) => f.signature.startsWith(`function ${name}(`));
    if (fn === undefined) throw new Error(`no ${name} scoped`);
    return fn;
  };

  it('T12-1: scopes all six functions on the singleton', () => {
    const names = singletonFunctions(['usdc_wsteth_86']).map(
      (f) => f.signature.replace(/^function /, '').split('(')[0],
    );
    expect(names).toEqual([
      'supply',
      'withdraw',
      'supplyCollateral',
      'withdrawCollateral',
      'borrow',
      'repay',
    ]);
  });

  it('T12-2: a single market collapses marketParams to a bare matches', () => {
    // An `or` with fewer than two branches is rejected at apply time, so the collapse is
    // load-bearing rather than cosmetic.
    for (const fn of singletonFunctions(['usdc_wsteth_86'])) {
      const mp = paramOf(fn, 'marketParams');
      expect(mp.operator).toBe('matches');
      expect(mp.conditions?.map((c) => c.value)).toEqual([USDC, WSTETH, ORACLE_A, IRM, LLTV]);
    }
  });

  it('T12-3: several markets wrap marketParams in an or, one branch each', () => {
    for (const fn of singletonFunctions(['usdc_wsteth_86', 'usdc_cbbtc_86'])) {
      const mp = paramOf(fn, 'marketParams');
      expect(mp.operator).toBe('or');
      expect(mp.conditions).toHaveLength(2);
      expect(mp.conditions?.[0]?.conditions?.map((c) => c.value)).toEqual([
        USDC,
        WSTETH,
        ORACLE_A,
        IRM,
        LLTV,
      ]);
    }
  });

  it('T12-4: entry directions pin shares to zero, exit directions leave it free', () => {
    const fns = singletonFunctions(['usdc_wsteth_86']);
    for (const name of ['supply', 'borrow']) {
      const shares = paramOf(fnNamed(fns, name), 'shares');
      expect(shares.operator).toBe('equal_to');
      expect(shares.value).toBe('0');
    }
    for (const name of ['withdraw', 'repay']) {
      expect(paramOf(fnNamed(fns, name), 'shares').operator).toBe('pass');
    }
  });

  it('T12-5: onBehalf is the avatar everywhere, receiver wherever it exists', () => {
    const fns = singletonFunctions(['usdc_wsteth_86']);
    for (const fn of fns) {
      expect(paramOf(fn, 'onBehalf').operator).toBe('equal_to_avatar');
    }
    for (const name of ['withdraw', 'withdrawCollateral', 'borrow']) {
      expect(paramOf(fnNamed(fns, name), 'receiver').operator).toBe('equal_to_avatar');
    }
  });

  it('T12-6: approves cover loan and collateral tokens, deduplicated', () => {
    const roles = rolesOf(['usdc_wsteth_86', 'wsteth_cbbtc_86']);
    const approveTargets = roles.filter((r) => r.address !== SINGLETON).map((r) => r.address);
    // USDC (loan of one), wstETH (collateral of one AND loan of the other — one entry
    // only), cbBTC (collateral of the other).
    expect(approveTargets).toEqual([USDC, WSTETH, CBBTC]);
    for (const r of roles.filter((x) => x.address !== SINGLETON)) {
      expect(paramOf(r.functions[0]!, 'spender').value).toBe(SINGLETON);
    }
  });

  it('T12-7: an unknown market key throws rather than rendering a hole', () => {
    expect(() =>
      env.render('morpho_blue/morpho_blue.tmpl', { markets: ['nope'], borrow: false }),
    ).toThrow();
  });

  it('T12-8: borrow=false scopes lending only, with no collateral approve', () => {
    const roles = rolesOf(['usdc_wsteth_86'], false);
    expect(
      singletonFunctions(['usdc_wsteth_86'], false).map(
        (f) => f.signature.replace(/^function /, '').split('(')[0],
      ),
    ).toEqual(['supply', 'withdraw']);
    // Only the loan token is approved: the Safe never hands collateral to the singleton
    // when it cannot post any.
    expect(roles.filter((r) => r.address !== SINGLETON).map((r) => r.address)).toEqual([USDC]);
  });

  it('T12-9: omitting borrow throws rather than defaulting to lending only', () => {
    // The gate is emitted as a value, not merely tested in an `{% if %}` — `throwOnUndefined`
    // only fires on emitted values, so a gate alone would leave the param optional and let an
    // existing config silently render as lending-only with nobody deciding.
    expect(() =>
      env.render('morpho_blue/morpho_blue.tmpl', { markets: ['usdc_wsteth_86'] }),
    ).toThrow();
  });

  it('T12-11: a quoted borrow value is rejected rather than widening the policy', () => {
    // YAML quoting picks the type and nunjucks picks truthiness: `"false"` is a
    // non-empty string, so a bare `{% if borrow %}` would scope the whole borrow
    // surface on the value an author wrote to withhold it. Measured before the fix:
    // `false` rendered 3 signatures, `"false"` rendered 8.
    for (const v of ['false', 'true', '0', 'no']) {
      expect(() =>
        env.render('morpho_blue/morpho_blue.tmpl', { markets: ['usdc_wsteth_86'], borrow: v }),
      ).toThrow(/must be a YAML boolean/);
    }
  });

  it('T12-10: duplicate market keys collapse to one branch', () => {
    // A repeated key would otherwise emit two identical `or` branches and defeat the
    // length-1 collapse.
    for (const fn of singletonFunctions(['usdc_wsteth_86', 'usdc_wsteth_86'])) {
      expect(paramOf(fn, 'marketParams').operator).toBe('matches');
    }
  });
});
