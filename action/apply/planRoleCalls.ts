import { ZacError } from '../errors';
import type { Generated } from './parseGenerated';
import { toSdkTargets } from './toSdkTargets';

/**
 * Single planned call returned by `planApplyRole`. Mirrors the SDK shape
 * `{ to, data }` but augments with `value` (always "0" for role-mod calls)
 * so the array is directly consumable by Safe Protocol Kit's
 * `createTransaction({ transactions: [...] })`.
 */
export type Call = { to: string; value: string; data: string };

/** Shape returned by `zodiac-roles-sdk`'s `planApplyRole`. */
type SdkPlannedCall = { to: `0x${string}`; data: `0x${string}` };

/** Inject for testability — test passes a stub matching this signature. */
export type PlanApplyRoleFn = (
  desired: { key: `0x${string}`; members: `0x${string}`[]; targets: unknown[] },
  meta: { chainId: number; address: `0x${string}` },
) => Promise<SdkPlannedCall[]>;

interface SdkBuilders {
  c: {
    eq: (v: unknown) => unknown;
    gt: (v: unknown) => unknown;
    lt: (v: unknown) => unknown;
    or: (...args: unknown[]) => unknown;
    matches: (scoping: unknown[]) => unknown;
    pass: unknown;
    calldataMatches: (scoping: unknown, abiTypes: readonly string[]) => unknown;
    avatar: unknown;
  };
  processPermissions: (perms: unknown[]) => { targets: unknown[] };
}

export interface PlanRoleCallsOpts {
  generated: Generated;
  /**
   * Injected SDK function for testability. Default: zodiac-roles-sdk's
   * `planApplyRole` (lazily imported so unit tests can avoid the network).
   */
  planApplyRole?: PlanApplyRoleFn;
  /** Inject `encodeKey` for testability (default: SDK's encodeKey). */
  encodeKey?: (key: string) => `0x${string}`;
  /** Inject the c-builder + processPermissions pair for testability. */
  sdkBuilders?: SdkBuilders;
}

export async function planRoleCalls(opts: PlanRoleCallsOpts): Promise<Call[]> {
  const sdk = await loadSdk(opts);

  const allCalls: Call[] = [];
  for (const [keyStr, role] of Object.entries(opts.generated.roles)) {
    const targets = sdk.builders
      ? toSdkTargets(opts.generated, keyStr, sdk.builders)
      : role.targets;
    const desired = {
      key: sdk.encodeKey(keyStr),
      members: role.members as `0x${string}`[],
      targets,
    };
    const meta = {
      chainId: opts.generated.deployment.chain_id,
      address: opts.generated.deployment.roles_modifier_address as `0x${string}`,
    };
    let result: SdkPlannedCall[];
    try {
      result = await sdk.planApplyRole(desired, meta);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ZacError({
        phase: 'apply',
        message: `planApplyRole failed for chainId=${meta.chainId} modifier=${meta.address} roleKey=${keyStr}: ${reason} (the SDK fetches current state from the Zodiac subgraph; check connectivity + that the modifier is indexed)`,
      });
    }
    for (const c of result) {
      allCalls.push({ to: c.to, value: '0', data: c.data });
    }
  }
  return allCalls;
}

async function loadSdk(opts: PlanRoleCallsOpts): Promise<{
  planApplyRole: PlanApplyRoleFn;
  encodeKey: (key: string) => `0x${string}`;
  builders: SdkBuilders | null;
}> {
  if (opts.planApplyRole !== undefined && opts.encodeKey !== undefined) {
    return {
      planApplyRole: opts.planApplyRole,
      encodeKey: opts.encodeKey,
      builders: opts.sdkBuilders ?? null,
    };
  }
  const mod = (await import('zodiac-roles-sdk')) as unknown as {
    planApplyRole: PlanApplyRoleFn;
    encodeKey: (key: string) => `0x${string}`;
    c: SdkBuilders['c'];
    processPermissions: SdkBuilders['processPermissions'];
  };
  return {
    planApplyRole: opts.planApplyRole ?? mod.planApplyRole,
    encodeKey: opts.encodeKey ?? mod.encodeKey,
    builders: opts.sdkBuilders ?? { c: mod.c, processPermissions: mod.processPermissions },
  };
}
