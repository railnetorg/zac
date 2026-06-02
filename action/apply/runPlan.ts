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
 * calldata, no Safe transaction. RPC-free: `planApplyRole` reads no chain
 * state and no Safe is initialized, so `plan` needs neither an RPC nor a
 * deployed Safe. The Safe tx (nonce, hash) is built later, at submit time.
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
