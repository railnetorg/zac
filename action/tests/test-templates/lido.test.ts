import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const STETH = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const QUEUE = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';
const UINT256_MAX =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

type RenderedFunction = {
  signature: string;
  execution_options: string;
  params?: unknown[];
};
type RenderedRole = { address: string; functions: RenderedFunction[] };

describe('lido/lido.tmpl', () => {
  // The production environment builder, so the `bool` filter the template relies
  // on is the one the CLI registers.
  const env = makeConfigEnv({
    searchPaths: [TEMPLATES_DIR],
    aliases: {
      ZERO,
      tokens: { WETH, stETH: STETH, wstETH: WSTETH },
      lido: { withdrawal_queue: QUEUE },
    },
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
    // `params:` block — a deployment has nothing to choose there. `exit` defaults
    // to false precisely so this stays true.
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

  it('T11-7: the reverse direction is not scoped unless exit is on', () => {
    // Exits go through a swap venue unless a config opts into Lido's own queue.
    // If `unwrap` or a withdrawal-queue call appears in a DEFAULT render, it is a
    // scope change and wants a decision.
    const out = env.render('lido/lido.tmpl', {});
    expect(out).not.toContain('unwrap');
    expect(out).not.toContain('requestWithdrawals');
    expect(out).not.toContain('claimWithdrawals');
    expect(out).not.toContain(QUEUE);
  });

  it('T11-8: the exit decision is emitted as a comment, defaulting to false', () => {
    // The comment is legible when rendering the template directly, and only
    // there: `runGenerate` re-emits via `toJSON()` + `serializeRoleStates`,
    // neither of which carries comments through to the generated artifact. It
    // does not catch a misspelled param name either — see T11-16.
    expect(env.render('lido/lido.tmpl', {})).toContain('# exit: false');
    expect(env.render('lido/lido.tmpl', { exit: true })).toContain('# exit: true');
  });

  it('T11-9: exit=true adds the queue target, the wstETH approve and WETH.deposit', () => {
    const roles = rolesOf({ exit: true });
    expect(functionsAt(roles, WETH).map((f) => f.signature)).toEqual([
      'function withdraw(uint256 amount)',
      'function deposit()',
    ]);
    expect(functionsAt(roles, WSTETH).map((f) => f.signature)).toEqual([
      'function wrap(uint256 amount)',
      'function approve(address spender, uint256 amount)',
    ]);
    expect(functionsAt(roles, QUEUE).map((f) => f.signature)).toEqual([
      'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner)',
      'function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)',
    ]);
  });

  it('T11-10: the withdrawal owner is pinned to the avatar', () => {
    // The whole containment argument for the exit leg rests on this: the claim
    // NFT, and therefore the ETH, can only ever be minted to the Safe.
    const request = functionsAt(rolesOf({ exit: true }), QUEUE).find((f) =>
      f.signature.startsWith('function requestWithdrawalsWstETH'),
    );
    expect(request?.params).toEqual([
      { name: '_amounts', param_type: 'dynamic', operator: 'pass' },
      { name: '_owner', param_type: 'static', operator: 'equal_to_avatar' },
    ]);
  });

  it('T11-11: the redirectable exit calls are never scoped, even with exit on', () => {
    // claimWithdrawalsTo takes a _recipient and setClaimRecipient-style redirection
    // is exactly what pinning _owner is meant to prevent; unwrap and the stETH
    // request variant would widen the exit path beyond wstETH-in / ETH-out.
    const out = env.render('lido/lido.tmpl', { exit: true });
    expect(out).not.toContain('claimWithdrawalsTo');
    expect(out).not.toContain('unwrap');
    expect(out).not.toContain('function requestWithdrawals(');
  });

  it('T11-12: exit=true grants send to WETH.deposit as well as submit', () => {
    const withSend = rolesOf({ exit: true })
      .flatMap((r) => r.functions)
      .filter((f) => f.execution_options === 'send')
      .map((f) => f.signature);
    expect(withSend).toEqual(['function deposit()', 'function submit(address referral)']);
  });

  it('T11-13: the exit approve is pinned to the queue with its own ceiling', () => {
    const approve = functionsAt(rolesOf({ exit: true }), WSTETH).find((f) =>
      f.signature.startsWith('function approve'),
    );
    expect(approve?.params).toEqual([
      {
        name: 'spender',
        param_type: 'static',
        operator: 'equal_to',
        value: QUEUE,
        value_type: 'address',
      },
      {
        name: 'amount',
        param_type: 'static',
        operator: 'less_than',
        value: UINT256_MAX,
        value_type: 'uint256',
      },
    ]);
    expect(
      env.render('lido/lido.tmpl', { exit: true, max_exit_approval: '4200000000000000000' }),
    ).toContain('value: "4200000000000000000"');
  });

  it('T11-15: a host repo that has not declared the lido namespace is unaffected', () => {
    // Host repos declare alias namespaces one by one in their root config.yaml, and
    // every declared namespace is loaded eagerly. A repo that predates this alias file
    // therefore has no `aliases.lido` at all — and picks the new template up the moment
    // it bumps its zac submodule, without touching its config. The default render must
    // not reach for the namespace, or that bump breaks every lido config in the repo.
    const noLido = makeConfigEnv({
      searchPaths: [TEMPLATES_DIR],
      aliases: { ZERO, tokens: { WETH, stETH: STETH, wstETH: WSTETH } },
    });
    expect(() => noLido.render('lido/lido.tmpl', {})).not.toThrow();
    expect(() => noLido.render('lido/lido.tmpl', { exit: false })).not.toThrow();
    // ...and asking for the leg without the namespace fails loudly rather than
    // emitting a policy with an empty target address.
    expect(() => noLido.render('lido/lido.tmpl', { exit: true })).toThrow();
  });

  it('T11-14: a stringy exit is rejected rather than read as truthy', () => {
    // "false" is a non-empty string and therefore truthy: without the bool filter
    // the gate would open on the value an author wrote to close it.
    for (const v of ['false', 'true', 1, 0, null]) {
      expect(() => env.render('lido/lido.tmpl', { exit: v })).toThrow();
    }
  });

  it('T11-16: a misspelled exit key is silently fail-closed, not an error', () => {
    // The cost of defaulting the gate instead of requiring it. `default(false)`
    // substitutes before anything can object, so `throwOnUndefined` never sees an
    // undefined lookup and `bool` is handed a real boolean. Every typo below
    // renders the mint-only policy with no signal to the author.
    //
    // This is fail-closed, so it is not a soundness hole — but it is the reason
    // `borrow` is required on aave_v3/morpho_blue, where `bool(undefined)` throws
    // because no default runs first. Pinned so the gap stays visible: if the
    // template ever drops the default, this test should be deleted, not updated.
    for (const key of ['exti', 'Exit', 'exit_leg', 'EXIT']) {
      const out = env.render('lido/lido.tmpl', { [key]: true });
      expect(out, key).toContain('# exit: false');
      expect(out, key).not.toContain(QUEUE);
    }
  });
});
