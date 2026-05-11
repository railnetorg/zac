import { ZacError } from '../errors';
import { parseGenerated } from './parseGenerated';
import { planRoleCalls, type PlanApplyRoleFn } from './planRoleCalls';
import { buildSafeTransaction, type SafeInitFn } from './safeApi';
import type { Plan } from './planSchema';

interface SdkBuilders {
  c: {
    eq: (v: unknown) => unknown;
    gt: (v: unknown) => unknown;
    lt: (v: unknown) => unknown;
    or: (...args: unknown[]) => unknown;
    calldataMatches: (scoping: unknown, abiTypes: readonly string[]) => unknown;
    avatar: unknown;
  };
  processPermissions: (perms: unknown[]) => { targets: unknown[] };
}

export interface RunPlanOpts {
  generatedPath: string;
  /** Defaults to `process.env.RPC_URL` (forwarded only if set). */
  rpcUrl?: string;
  planApplyRole?: PlanApplyRoleFn;
  encodeKey?: (key: string) => `0x${string}`;
  sdkBuilders?: SdkBuilders;
  safeInit?: SafeInitFn;
}

/**
 * Compute the Safe transaction (calls + safeTxHash + safeTxData) for a
 * generated ZAC config, without signing or posting.
 */
export async function runPlan(opts: RunPlanOpts): Promise<Plan> {
  const rpcUrl = opts.rpcUrl ?? process.env['RPC_URL'];

  const generated = parseGenerated(opts.generatedPath);

  const planArgs: Parameters<typeof planRoleCalls>[0] = { generated };
  if (opts.planApplyRole !== undefined) planArgs.planApplyRole = opts.planApplyRole;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  if (opts.sdkBuilders !== undefined) planArgs.sdkBuilders = opts.sdkBuilders;
  const calls = await planRoleCalls(planArgs);

  if (calls.length === 0) {
    throw new ZacError({
      phase: 'apply',
      message: 'planApplyRole returned 0 calls — role state is already in sync, nothing to propose',
    });
  }

  const buildArgs: Parameters<typeof buildSafeTransaction>[0] = {
    chainId: generated.deployment.chain_id,
    safeAddress: generated.deployment.safe_address,
    calls,
  };
  if (rpcUrl !== undefined) buildArgs.rpcUrl = rpcUrl;
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
