import { describe, it, expect } from 'vitest';
import type { Log } from 'viem';
import {
  CLEARANCE,
  EXECUTION_OPTIONS,
  collectLogs,
  fetchRolesModState,
  findCreationBlock,
  isTransientRpcError,
  reduceRolesModState,
  rpcErrorDetails,
  unflattenCondition,
  type DecodedRolesEvent,
  type Hex,
  type LogsClient,
} from '../../apply/rolesModState';
import { ZacError } from '../../errors';

const MOD: Hex = '0x97dfc336e2a52c279d7ff7b4b0d70cf381b427b5';
const ROLE_A: Hex = `0x${'41'.padEnd(64, '0')}`; // "A"
const ROLE_B: Hex = `0x${'42'.padEnd(64, '0')}`; // "B"
const USDC: Hex = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // checksummed on purpose
const USDC_LC = USDC.toLowerCase() as Hex;
const MEMBER: Hex = '0x4eCb9f7c0e1dE33eD8E2B2f8c3B9d8Ff5A1c71A6';
const APPROVE = '0x095ea7b3';
const TRANSFER = '0xa9059cbb';

const ev = (eventName: string, args: Record<string, unknown>): DecodedRolesEvent => ({
  eventName,
  args,
});

describe('unflattenCondition', () => {
  it('rebuilds the tree from BFS rows, drops 0x compValues and empty children', () => {
    // calldataMatches([eq(spender), pass]) as the SDK flattens it:
    // 0: Calldata/Matches (parent 0), 1: Static/EqualTo (parent 0), 2: Static/Pass (parent 0)
    const tree = unflattenCondition([
      { parent: 0, paramType: 5, operator: 5, compValue: '0x' },
      { parent: 0, paramType: 1, operator: 16, compValue: `0x${'11'.repeat(32)}` },
      { parent: 0, paramType: 1, operator: 0, compValue: '0x' },
    ]);
    expect(tree).toEqual({
      paramType: 5,
      operator: 5,
      children: [
        { paramType: 1, operator: 16, compValue: `0x${'11'.repeat(32)}` },
        { paramType: 1, operator: 0 },
      ],
    });
    expect('compValue' in tree).toBe(false);
  });

  it('nests grandchildren under the right parent', () => {
    // 0: Calldata/Matches, 1: Tuple/Matches (parent 0), 2: Static/Pass (parent 1), 3: Static/EqualTo (parent 1)
    const tree = unflattenCondition([
      { parent: 0, paramType: 5, operator: 5, compValue: '0x' },
      { parent: 0, paramType: 3, operator: 5, compValue: '0x' },
      { parent: 1, paramType: 1, operator: 0, compValue: '0x' },
      { parent: 1, paramType: 1, operator: 16, compValue: '0x01' },
    ]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0]!.children).toEqual([
      { paramType: 1, operator: 0 },
      { paramType: 1, operator: 16, compValue: '0x01' },
    ]);
  });

  it('rejects an empty set and a forward parent reference', () => {
    expect(() => unflattenCondition([])).toThrow(ZacError);
    expect(() =>
      unflattenCondition([
        { parent: 0, paramType: 5, operator: 5, compValue: '0x' },
        { parent: 2, paramType: 1, operator: 0, compValue: '0x' },
        { parent: 0, paramType: 1, operator: 0, compValue: '0x' },
      ]),
    ).toThrow(/invalid parent/);
  });
});

describe('reduceRolesModState', () => {
  it('starts empty: no roles, no allowances, zero owner/avatar/target', () => {
    const s = reduceRolesModState(MOD, []);
    expect(s).toEqual({
      address: MOD,
      owner: `0x${'0'.repeat(40)}`,
      avatar: `0x${'0'.repeat(40)}`,
      target: `0x${'0'.repeat(40)}`,
      roles: [],
      allowances: [],
      multiSendAddresses: [],
    });
  });

  it('tracks owner/avatar/target through setup and later changes', () => {
    const s = reduceRolesModState(MOD, [
      ev('RolesModSetup', { initiator: MEMBER, owner: USDC, avatar: USDC, target: USDC }),
      ev('OwnershipTransferred', { previousOwner: USDC, newOwner: MEMBER }),
      ev('TargetSet', { previousTarget: USDC, newTarget: MEMBER }),
    ]);
    expect(s.owner).toBe(MEMBER.toLowerCase());
    expect(s.avatar).toBe(USDC_LC);
    expect(s.target).toBe(MEMBER.toLowerCase());
  });

  it('assignRoles joins and leaves per role key, creating roles on first touch', () => {
    const s = reduceRolesModState(MOD, [
      ev('AssignRoles', { module: MEMBER, roleKeys: [ROLE_A, ROLE_B], memberOf: [true, true] }),
      ev('AssignRoles', { module: MEMBER, roleKeys: [ROLE_B], memberOf: [false] }),
    ]);
    expect(s.roles.map((r) => r.key)).toEqual([ROLE_A, ROLE_B]);
    expect(s.roles[0]!.members).toEqual([MEMBER.toLowerCase()]);
    expect(s.roles[1]!.members).toEqual([]);
    expect(s.roles[0]).toMatchObject({ annotations: [], lastUpdate: 0, targets: [] });
  });

  it('allowTarget / scopeTarget / revokeTarget drive clearance, keep scoped functions', () => {
    const base = [
      ev('ScopeTarget', { roleKey: ROLE_A, targetAddress: USDC }),
      ev('ScopeFunction', {
        roleKey: ROLE_A,
        targetAddress: USDC,
        selector: APPROVE,
        conditions: [{ parent: 0, paramType: 5, operator: 5, compValue: '0x' }],
        options: EXECUTION_OPTIONS.None,
      }),
    ];
    const scoped = reduceRolesModState(MOD, base);
    const t = scoped.roles[0]!.targets[0]!;
    expect(t).toMatchObject({
      address: USDC_LC,
      clearance: CLEARANCE.Function,
      executionOptions: EXECUTION_OPTIONS.None,
    });
    expect(t.functions).toEqual([
      {
        selector: APPROVE,
        executionOptions: EXECUTION_OPTIONS.None,
        wildcarded: false,
        condition: { paramType: 5, operator: 5 },
      },
    ]);

    const allowed = reduceRolesModState(MOD, [
      ...base,
      ev('AllowTarget', { roleKey: ROLE_A, targetAddress: USDC, options: EXECUTION_OPTIONS.Send }),
    ]);
    expect(allowed.roles[0]!.targets[0]).toMatchObject({
      clearance: CLEARANCE.Target,
      executionOptions: EXECUTION_OPTIONS.Send,
    });
    // storage keeps the function entry; the SDK diff plans its revokeFunction
    expect(allowed.roles[0]!.targets[0]!.functions).toHaveLength(1);

    const revoked = reduceRolesModState(MOD, [
      ...base,
      ev('RevokeTarget', { roleKey: ROLE_A, targetAddress: USDC }),
    ]);
    expect(revoked.roles[0]!.targets[0]).toMatchObject({
      clearance: CLEARANCE.None,
      executionOptions: EXECUTION_OPTIONS.None,
    });
    expect(revoked.roles[0]!.targets[0]!.functions).toHaveLength(1);
  });

  it('allowFunction wildcards, scopeFunction re-scopes, revokeFunction deletes', () => {
    const s = reduceRolesModState(MOD, [
      ev('ScopeTarget', { roleKey: ROLE_A, targetAddress: USDC }),
      ev('AllowFunction', {
        roleKey: ROLE_A,
        targetAddress: USDC,
        selector: TRANSFER,
        options: EXECUTION_OPTIONS.Both,
      }),
      ev('AllowFunction', {
        roleKey: ROLE_A,
        targetAddress: USDC,
        selector: APPROVE,
        options: EXECUTION_OPTIONS.None,
      }),
      ev('ScopeFunction', {
        roleKey: ROLE_A,
        targetAddress: USDC,
        selector: APPROVE,
        conditions: [{ parent: 0, paramType: 5, operator: 5, compValue: '0x' }],
        options: EXECUTION_OPTIONS.Send,
      }),
      ev('RevokeFunction', { roleKey: ROLE_A, targetAddress: USDC, selector: TRANSFER }),
    ]);
    expect(s.roles[0]!.targets[0]!.functions).toEqual([
      {
        selector: APPROVE,
        executionOptions: EXECUTION_OPTIONS.Send,
        wildcarded: false,
        condition: { paramType: 5, operator: 5 },
      },
    ]);
  });

  it('allowFunction on an untouched target creates it with clearance None (as the contract stores it)', () => {
    const s = reduceRolesModState(MOD, [
      ev('AllowFunction', {
        roleKey: ROLE_A,
        targetAddress: USDC,
        selector: TRANSFER,
        options: EXECUTION_OPTIONS.None,
      }),
    ]);
    expect(s.roles[0]!.targets[0]).toMatchObject({ clearance: CLEARANCE.None });
    expect(s.roles[0]!.targets[0]!.functions[0]).toMatchObject({ wildcarded: true });
  });

  it('setAllowance creates/overwrites, consumeAllowance only moves the balance', () => {
    const KEY: Hex = `0x${'aa'.repeat(32)}`;
    const s = reduceRolesModState(MOD, [
      ev('SetAllowance', {
        allowanceKey: KEY,
        balance: 100n,
        maxRefill: 100n,
        refill: 10n,
        period: 3600n,
        timestamp: 1n,
      }),
      ev('ConsumeAllowance', { allowanceKey: KEY, consumed: 30n, newBalance: 70n }),
      ev('ConsumeAllowance', {
        allowanceKey: `0x${'bb'.repeat(32)}`,
        consumed: 1n,
        newBalance: 0n,
      }),
    ]);
    expect(s.allowances).toEqual([
      { key: KEY, balance: 70n, maxRefill: 100n, refill: 10n, period: 3600n, timestamp: 1n },
    ]);
  });

  it('derives multiSendAddresses from the recognized MultiSend unwrap adapters only', () => {
    const MS: Hex = '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526';
    const MSCO: Hex = '0x9641d764fc13c8b624c04430c7356c1c7c8102e2';
    const s = reduceRolesModState(MOD, [
      ev('SetUnwrapAdapter', {
        to: MS,
        selector: '0x8d80ff0a',
        adapter: '0xb4cd4bb764c089f20da18700ce8bc5e49f369efd',
      }),
      ev('SetUnwrapAdapter', {
        to: MSCO,
        selector: '0x8d80ff0a',
        adapter: '0xB4cd4Bb764c089F20Da18700cE8bc5e49F369Efd',
      }),
      ev('SetUnwrapAdapter', { to: USDC, selector: '0x8d80ff0a', adapter: MEMBER }), // unknown adapter
      ev('SetUnwrapAdapter', { to: MSCO, selector: '0x8d80ff0a', adapter: `0x${'0'.repeat(40)}` }), // removal
    ]);
    expect(s.multiSendAddresses).toEqual([MS]);
  });

  it('lowercases keys, addresses and selectors', () => {
    const s = reduceRolesModState(MOD.toUpperCase().replace('0X', '0x') as Hex, [
      ev('AssignRoles', {
        module: MEMBER,
        roleKeys: [ROLE_A.toUpperCase().replace('0X', '0x')],
        memberOf: [true],
      }),
      ev('AllowFunction', {
        roleKey: ROLE_A,
        targetAddress: USDC,
        selector: '0xA9059CBB',
        options: 0,
      }),
    ]);
    expect(s.address).toBe(MOD);
    expect(s.roles).toHaveLength(1);
    expect(s.roles[0]!.key).toBe(ROLE_A);
    expect(s.roles[0]!.members).toEqual([MEMBER.toLowerCase()]);
    expect(s.roles[0]!.targets[0]!.address).toBe(USDC_LC);
    expect(s.roles[0]!.targets[0]!.functions[0]!.selector).toBe(TRANSFER);
  });

  it('rejects malformed args with a ZacError in phase apply', () => {
    expect(() =>
      reduceRolesModState(MOD, [ev('AllowTarget', { roleKey: 12, targetAddress: USDC })]),
    ).toThrow(ZacError);
    expect(() =>
      reduceRolesModState(MOD, [
        ev('AssignRoles', { module: MEMBER, roleKeys: [ROLE_A], memberOf: [] }),
      ]),
    ).toThrow(/length mismatch/);
  });
});

function fakeClient(opts: {
  latest: bigint;
  creation: bigint;
  maxRange?: bigint;
  archive?: boolean;
  logsAt?: bigint[];
  /** Fail this many getLogs/getCode calls with a rate-limit error before serving. */
  rateLimitFirst?: number;
}): LogsClient & { calls: { getLogs: [bigint, bigint][]; getCode: bigint[] } } {
  const calls = { getLogs: [] as [bigint, bigint][], getCode: [] as bigint[] };
  let throttled = opts.rateLimitFirst ?? 0;
  const maybeThrottle = () => {
    if (throttled > 0) {
      throttled--;
      throw new Error('You reached Public endpoint rate limit, please upgrade to paid plan');
    }
  };
  return {
    calls,
    getBlockNumber: async () => opts.latest,
    getCode: async ({ blockNumber }) => {
      calls.getCode.push(blockNumber);
      maybeThrottle();
      if (opts.archive === false && blockNumber < opts.latest) throw new Error('missing trie node');
      return blockNumber >= opts.creation ? '0x6080' : '0x';
    },
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.getLogs.push([fromBlock, toBlock]);
      maybeThrottle();
      if (opts.maxRange !== undefined && toBlock - fromBlock + 1n > opts.maxRange) {
        throw new Error('ranges over 10000 blocks are not supported on free plan');
      }
      return (opts.logsAt ?? [])
        .filter((b) => b >= fromBlock && b <= toBlock)
        .map((b) => ({ blockNumber: b, logIndex: 0 }) as unknown as Log);
    },
  };
}

describe('fetchRolesModState', () => {
  it('plans against an empty state, with a warning, when the RPC has no code for the modifier', async () => {
    // Foundry fork tests deploy the modifier inside forge's EVM; the upstream RPC
    // never sees it. The subgraph used to answer null there — same outcome.
    const c = fakeClient({ latest: 1_000n, creation: 5_000n });
    const notes: string[] = [];
    const state = await fetchRolesModState({
      rpcUrl: 'http://rpc.test',
      address: MOD,
      abi: [],
      client: c,
      log: (l) => notes.push(l),
    });
    expect(state).toEqual(reduceRolesModState(MOD, []));
    expect(notes.join('')).toMatch(/no contract code/);
    expect(c.calls.getLogs).toEqual([]);
  });

  it('rebuilds from the log when the modifier exists', async () => {
    const c = fakeClient({ latest: 1_000n, creation: 100n, logsAt: [] });
    const state = await fetchRolesModState({
      rpcUrl: 'http://rpc.test',
      address: MOD,
      abi: [],
      client: c,
    });
    expect(state.roles).toEqual([]);
    expect(c.calls.getLogs).toEqual([[100n, 1_000n]]);
  });
});

describe('findCreationBlock', () => {
  it('binary-searches the first block with code', async () => {
    const c = fakeClient({ latest: 1_000_000n, creation: 123_456n });
    expect(await findCreationBlock(c, MOD, 1_000_000n)).toBe(123_456n);
    expect(c.calls.getCode.length).toBeLessThan(30);
  });

  it('falls back to genesis (and warns) when historical getCode is refused', async () => {
    const c = fakeClient({ latest: 1_000n, creation: 500n, archive: false });
    const notes: string[] = [];
    expect(await findCreationBlock(c, MOD, 1_000n, (l) => notes.push(l))).toBe(0n);
    expect(notes.join('')).toMatch(/archive/);
  });
});

describe('collectLogs', () => {
  it('fetches the whole range in one call when the provider allows it', async () => {
    const c = fakeClient({ latest: 2_000n, creation: 0n, logsAt: [10n, 1_999n] });
    const logs = await collectLogs(c, MOD, 0n, 2_000n);
    expect(logs).toHaveLength(2);
    expect(c.calls.getLogs).toEqual([[0n, 2_000n]]);
  });

  it('halves the chunk on a range error, keeps the size that worked, and loses no log', async () => {
    const logsAt = [5n, 10_000n, 10_001n, 25_000n, 40_000n];
    const c = fakeClient({ latest: 40_000n, creation: 0n, maxRange: 10_000n, logsAt });
    const notes: string[] = [];
    const logs = await collectLogs(c, MOD, 0n, 40_000n, (l) => notes.push(l));
    expect(logs.map((l) => l.blockNumber)).toEqual(logsAt);
    const ok = c.calls.getLogs.filter(([f, t]) => t - f + 1n <= 10_000n);
    expect(ok.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < ok.length; i++) expect(ok[i]![0]).toBe(ok[i - 1]![1] + 1n);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('gives up with a ZacError when even a single block is refused', async () => {
    const c = fakeClient({ latest: 10n, creation: 0n, maxRange: 0n });
    await expect(collectLogs(c, MOD, 0n, 10n)).rejects.toThrow(ZacError);
  });

  it('waits out a rate limit at the same chunk size instead of halving', async () => {
    const c = fakeClient({ latest: 2_000n, creation: 0n, logsAt: [7n], rateLimitFirst: 3 });
    const slept: number[] = [];
    const logs = await collectLogs(c, MOD, 0n, 2_000n, undefined, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(logs.map((l) => l.blockNumber)).toEqual([7n]);
    expect(c.calls.getLogs).toEqual([
      [0n, 2_000n],
      [0n, 2_000n],
      [0n, 2_000n],
      [0n, 2_000n],
    ]);
    expect(slept).toEqual([1_000, 2_000, 4_000]);
  });

  it('surfaces a rate limit that never clears as a ZacError, without shrinking', async () => {
    const c = fakeClient({ latest: 2_000n, creation: 0n, rateLimitFirst: 99 });
    await expect(
      collectLogs(c, MOD, 0n, 2_000n, undefined, { maxAttempts: 3, sleep: async () => {} }),
    ).rejects.toThrow(/rate limit/);
    expect(c.calls.getLogs).toHaveLength(3);
  });
});

describe('isTransientRpcError / rpcErrorDetails', () => {
  it('classifies provider messages and HTTP statuses', () => {
    expect(isTransientRpcError(new Error('You reached Public endpoint rate limit'))).toBe(true);
    expect(
      isTransientRpcError(Object.assign(new Error('HTTP request failed.'), { status: 429 })),
    ).toBe(true);
    expect(
      isTransientRpcError(Object.assign(new Error('HTTP request failed.'), { status: 502 })),
    ).toBe(true);
    expect(isTransientRpcError(new Error('ranges over 10000 blocks are not supported'))).toBe(
      false,
    );
    expect(isTransientRpcError(new Error('query returned more than 10000 results'))).toBe(false);
    expect(
      rpcErrorDetails(
        Object.assign(new Error('RPC Request failed.\n\nURL: x\nRequest body: {}'), {
          details: 'You reached Public endpoint rate limit, please upgrade to paid plan',
        }),
      ),
    ).toBe('You reached Public endpoint rate limit, please upgrade to paid plan');
  });
});
