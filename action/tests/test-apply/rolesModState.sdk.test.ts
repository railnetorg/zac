import { describe, it, expect } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  callsPlannedForApply,
  encodeCalls,
  encodeKey,
  processPermissions,
  rolesAbi,
  c,
} from 'zodiac-roles-sdk';
import { reduceRolesModState, type DecodedRolesEvent, type Hex } from '../../apply/rolesModState';

/**
 * Round trip against the REAL SDK, offline: plan a role from empty, decode
 * the planned calldata back into the events the modifier would emit,
 * replay them into our state, and check the SDK now sees nothing to do.
 * This pins the reconstructed shape (enums, casing, condition trees) to
 * exactly what `callsPlannedForApply` diffs against.
 */

const MOD: Hex = '0x97dfc336e2a52c279d7ff7b4b0d70cf381b427b5';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const MEMBER = '0x4ecb9f7c0e1de33ed8e2b2f8c3b9d8ff5a1c71a6';

function desiredRole() {
  const { targets } = processPermissions([
    {
      targetAddress: USDC,
      signature: 'approve(address,uint256)',
      condition: c.calldataMatches([c.eq(COMET), undefined], ['address', 'uint256']),
    },
    { targetAddress: COMET, signature: 'supply(address,uint256)' },
    { targetAddress: COMET, signature: 'withdraw(address,uint256)', send: true },
  ]);
  return {
    key: encodeKey('COMPOUND_V3'),
    members: [MEMBER as Hex],
    targets,
    annotations: [],
    lastUpdate: 0,
  };
}

/** Decode planned role-mod calldata into the event the contract emits for it. */
function eventsFor(calls: { to: Hex; data: Hex }[]): DecodedRolesEvent[] {
  return calls.map(({ data }) => {
    const { functionName, args } = decodeFunctionData({ abi: rolesAbi, data });
    const a = args as readonly unknown[];
    switch (functionName) {
      case 'assignRoles':
        return { eventName: 'AssignRoles', args: { module: a[0], roleKeys: a[1], memberOf: a[2] } };
      case 'scopeTarget':
        return { eventName: 'ScopeTarget', args: { roleKey: a[0], targetAddress: a[1] } };
      case 'allowTarget':
        return {
          eventName: 'AllowTarget',
          args: { roleKey: a[0], targetAddress: a[1], options: a[2] },
        };
      case 'revokeTarget':
        return { eventName: 'RevokeTarget', args: { roleKey: a[0], targetAddress: a[1] } };
      case 'allowFunction':
        return {
          eventName: 'AllowFunction',
          args: { roleKey: a[0], targetAddress: a[1], selector: a[2], options: a[3] },
        };
      case 'scopeFunction':
        return {
          eventName: 'ScopeFunction',
          args: {
            roleKey: a[0],
            targetAddress: a[1],
            selector: a[2],
            conditions: a[3],
            options: a[4],
          },
        };
      case 'revokeFunction':
        return {
          eventName: 'RevokeFunction',
          args: { roleKey: a[0], targetAddress: a[1], selector: a[2] },
        };
      default:
        throw new Error(`unexpected planned call ${functionName}`);
    }
  });
}

describe('rolesModState × zodiac-roles-sdk', () => {
  it('a state replayed from the planned calls diffs to zero against the same desired role', () => {
    const role = desiredRole();
    const empty = reduceRolesModState(MOD, []);
    const bootstrap = callsPlannedForApply(empty, { roles: [role], allowances: [] });
    expect(bootstrap.length).toBeGreaterThan(3);

    const current = reduceRolesModState(MOD, eventsFor(encodeCalls(bootstrap, MOD)));
    expect(current.roles).toHaveLength(1);
    expect(current.roles[0]!.members).toEqual([MEMBER.toLowerCase()]);
    expect(current.roles[0]!.targets.map((t) => t.address)).toEqual([
      USDC.toLowerCase(),
      COMET.toLowerCase(),
    ]);

    const again = callsPlannedForApply(current, { roles: [role], allowances: [] });
    expect(again).toEqual([]);
  });

  it('a desired change against the replayed state plans exactly that change', () => {
    const role = desiredRole();
    const empty = reduceRolesModState(MOD, []);
    const current = reduceRolesModState(
      MOD,
      eventsFor(encodeCalls(callsPlannedForApply(empty, { roles: [role], allowances: [] }), MOD)),
    );

    // Drop the member and the withdraw leg: expect one leave + one revokeFunction, nothing else.
    const { targets } = processPermissions([
      {
        targetAddress: USDC,
        signature: 'approve(address,uint256)',
        condition: c.calldataMatches([c.eq(COMET), undefined], ['address', 'uint256']),
      },
      { targetAddress: COMET, signature: 'supply(address,uint256)' },
    ]);
    const narrowed = { ...role, members: [], targets };
    const calls = callsPlannedForApply(current, { roles: [narrowed], allowances: [] }) as {
      call: string;
    }[];
    expect(calls.map((x) => x.call).sort()).toEqual(['assignRoles', 'revokeFunction']);

    // And dropping the role entirely revokes everything it had.
    const wipe = callsPlannedForApply(current, { roles: [], allowances: [] }) as { call: string }[];
    expect(wipe.map((x) => x.call).sort()).toEqual([
      'assignRoles',
      'revokeFunction',
      'revokeFunction',
      'revokeFunction',
      'revokeTarget',
      'revokeTarget',
    ]);
  });
});
