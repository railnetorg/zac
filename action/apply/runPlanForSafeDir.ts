import { generatedPathFor } from '../discover';
import type { SafeDir } from '../discover';
import { parseGenerated, type Generated } from './parseGenerated';
import { planSafeDirCalls, type PlanApplyFn } from './planSafeDirCalls';
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

export interface RunPlanForSafeDirOpts {
  safeDir: SafeDir;
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
  /** Inject for testability — defaults to `parseGenerated`. */
  parseGenerated?: (p: string) => Generated;
}

/**
 * Compute ONE Safe transaction (calls + safeTxHash + safeTxData) for the
 * whole safe-dir via the SDK's per-modifier `planApply`. The aggregated
 * `desired.roles` is the union across every source in `safeDir.sources`;
 * the SDK natively emits revoke calls for any role on the modifier not in
 * the aggregated set (the "revoke unmentioned" default).
 *
 * Returns `null` when the aggregated `planApply` produces 0 calls — i.e.
 * the on-chain role state already matches the aggregated desired state
 * and there is nothing to propose. "In sync" is a SUCCESS condition; the
 * caller decides how to surface it (the CLI prints a one-liner and skips
 * the plan-file write).
 */
export async function runPlanForSafeDir(opts: RunPlanForSafeDirOpts): Promise<Plan | null> {
  const parse = opts.parseGenerated ?? parseGenerated;

  const generateds: Generated[] = opts.safeDir.sources.map((src) => parse(generatedPathFor(src)));

  const resolveArgs: Parameters<typeof resolveRpcUrl>[0] = { chainId: opts.safeDir.chainId };
  if (opts.rpcUrl !== undefined) resolveArgs.overrideUrl = opts.rpcUrl;
  const rpcUrl = resolveRpcUrl(resolveArgs);

  const planArgs: Parameters<typeof planSafeDirCalls>[0] = { generateds };
  if (opts.planApply !== undefined) planArgs.planApply = opts.planApply;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  if (opts.sdkBuilders !== undefined) planArgs.sdkBuilders = opts.sdkBuilders;
  const calls = await planSafeDirCalls(planArgs);

  if (calls.length === 0) {
    // In sync — no Safe tx to build. Caller short-circuits.
    return null;
  }

  const buildArgs: Parameters<typeof buildSafeTransaction>[0] = {
    chainId: opts.safeDir.chainId,
    safeAddress: opts.safeDir.safeAddress,
    calls,
    rpcUrl,
  };
  if (opts.safeInit !== undefined) buildArgs.safeInit = opts.safeInit;
  const { safeTxHash, safeTxData } = await buildSafeTransaction(buildArgs);

  return {
    calls,
    callsCount: calls.length,
    chainId: opts.safeDir.chainId,
    modifierAddress: opts.safeDir.modifierAddress,
    safeAddress: opts.safeDir.safeAddress,
    safeTxData,
    safeTxHash,
  };
}
