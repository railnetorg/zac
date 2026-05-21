import { parseGenerated } from './parseGenerated';
import { planRoleCalls, type PlanApplyRoleFn } from './planRoleCalls';
import { resolveRpcUrl } from './rpc';
import { buildSafeTransaction, type SafeInitFn } from './safeApi';
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
  /**
   * CLI `--rpc-url` override. When omitted, the URL is resolved per-chain
   * via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`) with `RPC_URL` as the
   * universal fallback. See `resolveRpcUrl`.
   */
  rpcUrl?: string;
  planApplyRole?: PlanApplyRoleFn;
  encodeKey?: (key: string) => `0x${string}`;
  sdkBuilders?: SdkBuilders;
  safeInit?: SafeInitFn;
}

/**
 * Compute the Safe transaction (calls + safeTxHash + safeTxData) for a
 * generated ZAC config, without signing or posting.
 *
 * Returns `null` when `planApplyRole` produces 0 calls — i.e. the on-chain
 * role state already matches the desired state and there is nothing to
 * propose. "In sync" is a SUCCESS condition; the caller decides how to
 * surface it (the CLI prints a one-liner and skips the plan-file write).
 */
export async function runPlan(opts: RunPlanOpts): Promise<Plan | null> {
  const generated = parseGenerated(opts.generatedPath);

  const resolveArgs: Parameters<typeof resolveRpcUrl>[0] = {
    chainId: generated.deployment.chain_id,
  };
  if (opts.rpcUrl !== undefined) resolveArgs.overrideUrl = opts.rpcUrl;
  const rpcUrl = resolveRpcUrl(resolveArgs);

  const planArgs: Parameters<typeof planRoleCalls>[0] = { generated };
  if (opts.planApplyRole !== undefined) planArgs.planApplyRole = opts.planApplyRole;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  if (opts.sdkBuilders !== undefined) planArgs.sdkBuilders = opts.sdkBuilders;
  const calls = await planRoleCalls(planArgs);

  if (calls.length === 0) {
    // In sync — no Safe tx to build. Caller short-circuits.
    return null;
  }

  const buildArgs: Parameters<typeof buildSafeTransaction>[0] = {
    chainId: generated.deployment.chain_id,
    safeAddress: generated.deployment.safe_address,
    calls,
    rpcUrl,
  };
  if (opts.safeInit !== undefined) buildArgs.safeInit = opts.safeInit;
  const { safeTxHash, safeTxData } = await buildSafeTransaction(buildArgs);

  return {
    calls,
    callsCount: calls.length,
    chainId: generated.deployment.chain_id,
    modifierAddress: generated.deployment.roles_modifier_address,
    safeAddress: generated.deployment.safe_address,
    safeTxData,
    safeTxHash,
  };
}
