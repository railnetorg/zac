import { ZacError } from '../errors';
import type { SafeDir } from '../discover';
import { runPlanForSafeDir } from './runPlanForSafeDir';
import { runSubmit } from './runSubmit';
import type { PlanApplyFn } from './planSafeDirCalls';
import type { Generated } from './parseGenerated';
import type { SafeInitFn, SafeApiKitCtor } from './safeApi';

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

export interface RunApplyForSafeDirOpts {
  safeDir: SafeDir;
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
  planApply?: PlanApplyFn;
  encodeKey?: (key: string) => `0x${string}`;
  sdkBuilders?: SdkBuilders;
  safeInit?: SafeInitFn;
  apiKitCtor?: SafeApiKitCtor;
  parseGenerated?: (p: string) => Generated;
}

/**
 * Per-safe-dir apply: compute the per-modifier plan (via `planApply`),
 * then sign + post as a single Safe transaction. This is the
 * `--revoke-unmentioned=true` (default) path.
 */
export async function runApplyForSafeDir(
  opts: RunApplyForSafeDirOpts,
): Promise<{ safeTxHash: string }> {
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

  const planArgs: Parameters<typeof runPlanForSafeDir>[0] = { safeDir: opts.safeDir };
  if (opts.rpcUrl !== undefined) planArgs.rpcUrl = opts.rpcUrl;
  if (opts.planApply !== undefined) planArgs.planApply = opts.planApply;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  if (opts.sdkBuilders !== undefined) planArgs.sdkBuilders = opts.sdkBuilders;
  if (opts.safeInit !== undefined) planArgs.safeInit = opts.safeInit;
  if (opts.parseGenerated !== undefined) planArgs.parseGenerated = opts.parseGenerated;
  const plan = await runPlanForSafeDir(planArgs);

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
