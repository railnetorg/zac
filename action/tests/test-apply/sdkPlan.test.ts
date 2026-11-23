import { describe, it, expect } from 'vitest';
import { makePlanApply, makePlanApplyRole, type SdkDiffFns } from '../../apply/sdkPlan';
import type { RolesModState, Hex } from '../../apply/rolesModState';

const MOD: Hex = '0x4444444444444444444444444444444444444444';
const KEY_A: Hex = `0x${'41'.padEnd(64, '0')}`;
const ALLOWANCE = {
  key: `0x${'aa'.repeat(32)}` as Hex,
  refill: 1n,
  maxRefill: 2n,
  period: 3n,
  balance: 4n,
  timestamp: 5n,
};

function state(roles: RolesModState['roles']): RolesModState {
  return {
    address: MOD,
    owner: MOD,
    avatar: MOD,
    target: MOD,
    roles,
    allowances: [ALLOWANCE],
    multiSendAddresses: [],
  };
}

function recordingSdk(): SdkDiffFns & { seen: { fn: string; prev: unknown; next: unknown }[] } {
  const seen: { fn: string; prev: unknown; next: unknown }[] = [];
  return {
    seen,
    callsPlannedForApply: (prev, next) => {
      seen.push({ fn: 'apply', prev, next });
      return ['call-1', 'call-2'];
    },
    callsPlannedForApplyRole: (prev, next) => {
      seen.push({ fn: 'applyRole', prev, next });
      return ['call-r'];
    },
    encodeCalls: (calls, rolesMod) =>
      calls.map((c, i) => ({ to: rolesMod, data: `0x${String(c).length}${i}` as Hex })),
  };
}

describe('makePlanApply', () => {
  it('replaces roles wholesale, carries allowances over, and encodes for the modifier', async () => {
    const sdk = recordingSdk();
    const fetched: unknown[] = [];
    const prev = state([{ key: KEY_A, members: [], targets: [], annotations: [], lastUpdate: 0 }]);
    const planApply = makePlanApply({
      rpcUrl: 'http://rpc.test',
      sdk,
      fetchState: async (o) => {
        fetched.push(o);
        return prev;
      },
    });
    const desiredRoles = [
      { key: KEY_A, members: [MOD], targets: [], annotations: [], lastUpdate: 0 },
    ];
    const out = await planApply({ roles: desiredRoles }, { chainId: 1, address: MOD });

    expect(fetched).toEqual([{ rpcUrl: 'http://rpc.test', address: MOD }]);
    expect(sdk.seen).toHaveLength(1);
    expect(sdk.seen[0]!.prev).toBe(prev);
    expect(sdk.seen[0]!.next).toEqual({ roles: desiredRoles, allowances: [ALLOWANCE] });
    expect(out).toEqual([
      { to: MOD, data: '0x60' },
      { to: MOD, data: '0x61' },
    ]);
  });
});

describe('makePlanApplyRole', () => {
  it('spreads the desired fragment over the existing role (case-insensitive key match)', async () => {
    const sdk = recordingSdk();
    const existing = {
      key: KEY_A,
      members: [MOD],
      targets: ['t-old'],
      annotations: [] as never[],
      lastUpdate: 0,
    } as unknown as RolesModState['roles'][number];
    const planApplyRole = makePlanApplyRole({
      rpcUrl: 'http://rpc.test',
      sdk,
      fetchState: async () => state([existing]),
    });
    await planApplyRole(
      { key: KEY_A.toUpperCase().replace('0X', '0x') as Hex, members: [], targets: ['t-new'] },
      { chainId: 1, address: MOD },
    );
    expect(sdk.seen[0]!.prev).toBe(existing);
    expect(sdk.seen[0]!.next).toEqual({
      key: KEY_A.toUpperCase().replace('0X', '0x'),
      members: [],
      targets: ['t-new'],
      annotations: [],
      lastUpdate: 0,
    });
  });

  it('starts from an empty role when the key is unknown on the modifier', async () => {
    const sdk = recordingSdk();
    const planApplyRole = makePlanApplyRole({
      rpcUrl: 'http://rpc.test',
      sdk,
      fetchState: async () => state([]),
    });
    const out = await planApplyRole(
      { key: KEY_A, members: [MOD], targets: [] },
      { chainId: 1, address: MOD },
    );
    expect(sdk.seen[0]!.prev).toBeUndefined();
    expect(sdk.seen[0]!.next).toEqual({
      key: KEY_A,
      members: [MOD],
      targets: [],
      annotations: [],
      lastUpdate: 0,
    });
    expect(out).toEqual([{ to: MOD, data: '0x60' }]);
  });
});
