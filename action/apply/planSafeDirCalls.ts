import { ZacError } from '../errors';
import type { Generated } from './parseGenerated';
import { toSdkTargets } from './toSdkTargets';
import type { Call } from './planRoleCalls';

/** Shape returned by `zodiac-roles-sdk`'s `planApply`. */
type SdkPlannedCall = { to: `0x${string}`; data: `0x${string}` };

/** Minimal Role shape consumed by the SDK's `planApply`. */
export interface SdkRole {
  key: `0x${string}`;
  members: `0x${string}`[];
  targets: unknown[];
  annotations: unknown[];
  lastUpdate: number;
}

/**
 * Inject for testability — test passes a stub matching this signature.
 * Mirrors `zodiac-roles-sdk`'s `planApply` (note: not `planApplyRole`).
 * The desired state is the FULL set of roles the modifier should end up
 * with; the SDK fetches current state from the Zodiac subgraph (when
 * `current` is omitted) and natively emits revoke calls for any role not
 * present in `desired.roles`.
 */
export type PlanApplyFn = (
  desired: { roles: SdkRole[] },
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

export interface PlanSafeDirCallsOpts {
  /**
   * Parsed generated configs for every source in the safe-dir. All entries
   * must share the same `(chain_id, safe_address, roles_modifier_address)`.
   * Caller (`findSafeDirs` / `runPlanForSafeDir`) enforces this.
   */
  generateds: Generated[];
  /**
   * Injected SDK function for testability. Default: zodiac-roles-sdk's
   * `planApply` (lazily imported so unit tests can avoid the network).
   */
  planApply?: PlanApplyFn;
  /** Inject `encodeKey` for testability (default: SDK's encodeKey). */
  encodeKey?: (key: string) => `0x${string}`;
  /** Inject the c-builder + processPermissions pair for testability. */
  sdkBuilders?: SdkBuilders;
}

/**
 * Compute the per-modifier role-state-update calls. Aggregates the union of
 * role keys across every `.zac.yaml` in the safe-dir and hands the full
 * set to the SDK's `planApply`, which natively emits revoke calls for any
 * role on the modifier not in the aggregated set (the "revoke unmentioned"
 * default).
 *
 * Role iteration order is deterministic: alphabetical by role key.
 */
export async function planSafeDirCalls(opts: PlanSafeDirCallsOpts): Promise<Call[]> {
  if (opts.generateds.length === 0) {
    throw new ZacError({
      phase: 'apply',
      message: 'planSafeDirCalls requires at least one parsed config',
    });
  }
  const sdk = await loadSdk(opts);

  // Aggregate roles across every source. The role-key uniqueness across
  // safe-dir sources is enforced upstream (no two sources should declare
  // the same key — `emit/mergeRoleStates` rejects key collisions per file
  // and the safe-dir aggregation is the next layer up). If the SAME key
  // appears in two files, this throws — the safe-dir model assumes one
  // role key per file.
  const seenKeys = new Set<string>();
  const aggregated: { keyStr: string; role: SdkRole }[] = [];
  for (const generated of opts.generateds) {
    for (const [keyStr, role] of Object.entries(generated.roles)) {
      if (seenKeys.has(keyStr)) {
        throw new ZacError({
          phase: 'validate',
          message: `duplicate role key '${keyStr}' across safe-dir sources — each role key must appear in at most one .zac.yaml per safe-dir`,
        });
      }
      seenKeys.add(keyStr);
      const targets = sdk.builders ? toSdkTargets(generated, keyStr, sdk.builders) : role.targets;
      aggregated.push({
        keyStr,
        role: {
          key: sdk.encodeKey(keyStr),
          members: role.members as `0x${string}`[],
          targets,
          annotations: [],
          lastUpdate: 0,
        },
      });
    }
  }
  // Deterministic ordering — alphabetical by role key string.
  aggregated.sort((a, b) => (a.keyStr < b.keyStr ? -1 : a.keyStr > b.keyStr ? 1 : 0));

  const first = opts.generateds[0]!;
  const meta = {
    chainId: first.deployment.chain_id,
    address: first.deployment.roles_modifier_address as `0x${string}`,
  };
  let result: SdkPlannedCall[];
  try {
    result = await sdk.planApply({ roles: aggregated.map((e) => e.role) }, meta);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ZacError({
      phase: 'apply',
      message: `planApply failed for chainId=${meta.chainId} modifier=${meta.address}: ${reason} (the SDK fetches current state from the Zodiac subgraph when no \`current\` is supplied; check connectivity + that the modifier is indexed)`,
    });
  }

  const out: Call[] = [];
  for (const c of result) {
    out.push({ to: c.to, value: '0', data: c.data });
  }
  return out;
}

async function loadSdk(opts: PlanSafeDirCallsOpts): Promise<{
  planApply: PlanApplyFn;
  encodeKey: (key: string) => `0x${string}`;
  builders: SdkBuilders | null;
}> {
  if (opts.planApply !== undefined && opts.encodeKey !== undefined) {
    return {
      planApply: opts.planApply,
      encodeKey: opts.encodeKey,
      builders: opts.sdkBuilders ?? null,
    };
  }
  const mod = (await import('zodiac-roles-sdk')) as unknown as {
    planApply: PlanApplyFn;
    encodeKey: (key: string) => `0x${string}`;
    c: SdkBuilders['c'];
    processPermissions: SdkBuilders['processPermissions'];
  };
  return {
    planApply: opts.planApply ?? mod.planApply,
    encodeKey: opts.encodeKey ?? mod.encodeKey,
    builders: opts.sdkBuilders ?? { c: mod.c, processPermissions: mod.processPermissions },
  };
}
