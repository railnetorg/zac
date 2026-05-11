import { ZacError } from '../errors';
import { runPlan } from './runPlan';
import { runSubmit } from './runSubmit';
import type { PlanApplyRoleFn } from './planRoleCalls';
import type { SafeInitFn, SafeApiKitCtor } from './safeApi';

export interface RunApplyOpts {
  generatedPath: string;
  /** Defaults to `process.env.ZAC_PROPOSER_PRIVATE_KEY`. */
  proposerPrivateKey?: `0x${string}`;
  /** Defaults to `process.env.SAFE_API_KEY` (forwarded only if set). */
  apiKey?: string;
  /** Defaults to `process.env.RPC_URL` (forwarded only if set). */
  rpcUrl?: string;
  planApplyRole?: PlanApplyRoleFn;
  encodeKey?: (key: string) => `0x${string}`;
  safeInit?: SafeInitFn;
  apiKitCtor?: SafeApiKitCtor;
}

export async function runApply(opts: RunApplyOpts): Promise<{ safeTxHash: string }> {
  const proposerKey =
    opts.proposerPrivateKey ??
    (process.env['ZAC_PROPOSER_PRIVATE_KEY'] as `0x${string}` | undefined);
  if (proposerKey === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: 'ZAC_PROPOSER_PRIVATE_KEY env var is required for apply',
    });
  }
  const apiKey = opts.apiKey ?? process.env['SAFE_API_KEY'];
  const rpcUrl = opts.rpcUrl ?? process.env['RPC_URL'];

  const planArgs: Parameters<typeof runPlan>[0] = { generatedPath: opts.generatedPath };
  if (rpcUrl !== undefined) planArgs.rpcUrl = rpcUrl;
  if (opts.planApplyRole !== undefined) planArgs.planApplyRole = opts.planApplyRole;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  if (opts.safeInit !== undefined) planArgs.safeInit = opts.safeInit;
  const plan = await runPlan(planArgs);

  const submitArgs: Parameters<typeof runSubmit>[0] = {
    plan,
    proposerPrivateKey: proposerKey,
  };
  if (apiKey !== undefined) submitArgs.apiKey = apiKey;
  if (rpcUrl !== undefined) submitArgs.rpcUrl = rpcUrl;
  if (opts.safeInit !== undefined) submitArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) submitArgs.apiKitCtor = opts.apiKitCtor;
  return runSubmit(submitArgs);
}
