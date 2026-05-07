import type { Generated } from './parseGenerated';

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

export interface PlanRoleCallsOpts {
  generated: Generated;
  /**
   * Injected SDK function for testability. Default: zodiac-roles-sdk's
   * `planApplyRole` (lazily imported so unit tests can avoid the network).
   */
  planApplyRole?: PlanApplyRoleFn;
  /** Inject `encodeKey` for testability (default: SDK's encodeKey). */
  encodeKey?: (key: string) => `0x${string}`;
}

export async function planRoleCalls(opts: PlanRoleCallsOpts): Promise<Call[]> {
  const sdk =
    opts.planApplyRole !== undefined && opts.encodeKey !== undefined
      ? { planApplyRole: opts.planApplyRole, encodeKey: opts.encodeKey }
      : await loadSdk(opts);

  const allCalls: Call[] = [];
  for (const [keyStr, role] of Object.entries(opts.generated.roles)) {
    const desired = {
      key: sdk.encodeKey(keyStr),
      members: role.members as `0x${string}`[],
      targets: role.targets,
    };
    const meta = {
      chainId: opts.generated.deployment.chain_id,
      address: opts.generated.deployment.roles_modifier_address as `0x${string}`,
    };
    const result = await sdk.planApplyRole(desired, meta);
    for (const c of result) {
      allCalls.push({ to: c.to, value: '0', data: c.data });
    }
  }
  return allCalls;
}

async function loadSdk(opts: PlanRoleCallsOpts): Promise<{
  planApplyRole: PlanApplyRoleFn;
  encodeKey: (key: string) => `0x${string}`;
}> {
  const mod = (await import('zodiac-roles-sdk')) as unknown as {
    planApplyRole: PlanApplyRoleFn;
    encodeKey: (key: string) => `0x${string}`;
  };
  return {
    planApplyRole: opts.planApplyRole ?? mod.planApplyRole,
    encodeKey: opts.encodeKey ?? mod.encodeKey,
  };
}
