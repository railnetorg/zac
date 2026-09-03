import { parseGenerated } from './parseGenerated';
import { planRoleCalls, type PlanApplyRoleFn } from './planRoleCalls';
import type { Plan } from './planSchema';

interface SdkBuilders {
  c: {
    eq: (v: unknown) => unknown;
    gt: (v: unknown) => unknown;
    lt: (v: unknown) => unknown;
    or: (...args: unknown[]) => unknown;
    matches: (scoping: unknown[]) => unknown;
    pass: unknown;
    calldataMatches: (scoping: unknown, abiTypes: readonly string[]) => unknown;
    abiEncodedMatches: (scoping: unknown, abiTypes: readonly string[]) => unknown;
    avatar: unknown;
  };
  processPermissions: (perms: unknown[]) => { targets: unknown[] };
}

export interface RunPlanOpts {
  generatedPath: string;
  planApplyRole?: PlanApplyRoleFn;
  encodeKey?: (key: string) => `0x${string}`;
  sdkBuilders?: SdkBuilders;
}

/**
 * Compute the role-state-update `calls` for a generated ZAC config — pure
 * calldata, no Safe transaction. No JSON-RPC endpoint and no deployed Safe
 * are needed, but this is NOT offline: `planApplyRole` diffs the desired
 * state against the role's current state, which it reads from the
 * gnosis-guild Roles indexer (a Subsquid GraphQL endpoint) whenever no
 * `current` is supplied — and nothing here supplies one. It also fetches the
 * modifier's config from that same indexer and, for a modifier the indexer
 * knows, the owner's Zodiac license over plain HTTP. So `plan` requires
 * network access, and it inherits the indexer's eventual consistency: a role
 * whose last update is not yet indexed diffs against stale state.
 * The Safe tx (nonce, hash) is built later, at submit time.
 *
 * Returns `null` when `planApplyRole` produces 0 calls — i.e. the on-chain
 * role state already matches the desired state and there is nothing to
 * propose. "In sync" is a SUCCESS condition; the caller decides how to
 * surface it (the CLI prints a one-liner and skips the plan-file write).
 */
export async function runPlan(opts: RunPlanOpts): Promise<Plan | null> {
  const generated = parseGenerated(opts.generatedPath);

  const planArgs: Parameters<typeof planRoleCalls>[0] = { generated };
  if (opts.planApplyRole !== undefined) planArgs.planApplyRole = opts.planApplyRole;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  if (opts.sdkBuilders !== undefined) planArgs.sdkBuilders = opts.sdkBuilders;
  const calls = await planRoleCalls(planArgs);

  if (calls.length === 0) {
    // In sync — nothing to propose. Caller short-circuits.
    return null;
  }

  return {
    calls,
    callsCount: calls.length,
    chainId: generated.deployment.chain_id,
    modifierAddress: generated.deployment.roles_modifier_address,
    safeAddress: generated.deployment.safe_address,
  };
}
