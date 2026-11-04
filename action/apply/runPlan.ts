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
  /** CLI `--rpc-url` override; otherwise resolved per-chain (`resolveRpcUrl`). */
  rpcUrl?: string;
  planApplyRole?: PlanApplyRoleFn;
  encodeKey?: (key: string) => `0x${string}`;
  sdkBuilders?: SdkBuilders;
}

/**
 * Compute the role-state-update `calls` for a generated ZAC config — pure
 * calldata, no Safe transaction. No deployed Safe is needed, but this is
 * NOT offline: `planApplyRole` diffs the desired state against the role's
 * current state, which the default implementation rebuilds from the
 * modifier's event log over the chain's JSON-RPC endpoint (`rpcUrl`, else
 * `<NETWORK>_RPC_URL` / `RPC_URL`). Gnosis Guild retired the public Roles
 * subgraph the SDK used to read; the log replay is exact as of the RPC's
 * latest block, with no indexing lag.
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
  if (opts.rpcUrl !== undefined) planArgs.rpcUrl = opts.rpcUrl;
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
