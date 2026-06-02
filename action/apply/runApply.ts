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
  /**
   * CLI `--rpc-url` override. When omitted, the URL is resolved per-chain
   * via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`) with `RPC_URL` as the
   * universal fallback. See `resolveRpcUrl`.
   */
  rpcUrl?: string;
  planApplyRole?: PlanApplyRoleFn;
  encodeKey?: (key: string) => `0x${string}`;
  safeInit?: SafeInitFn;
  apiKitCtor?: SafeApiKitCtor;
}

/**
 * Returns `null` when the underlying `runPlan` reports the role state is
 * already in sync (0 calls); programmatic callers should treat that as a
 * noop SUCCESS and skip submit.
 */
export async function runApply(opts: RunApplyOpts): Promise<{ safeTxHash: string } | null> {
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

  const planArgs: Parameters<typeof runPlan>[0] = { generatedPath: opts.generatedPath };
  if (opts.planApplyRole !== undefined) planArgs.planApplyRole = opts.planApplyRole;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  const plan = await runPlan(planArgs);
  if (plan === null) return null;

  const submitArgs: Parameters<typeof runSubmit>[0] = {
    plan,
    proposerPrivateKey: proposerKey,
  };
  if (apiKey !== undefined) submitArgs.apiKey = apiKey;
  if (opts.rpcUrl !== undefined) submitArgs.rpcUrl = opts.rpcUrl;
  if (opts.safeInit !== undefined) submitArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) submitArgs.apiKitCtor = opts.apiKitCtor;
  return runSubmit(submitArgs);
}
