import { dirname } from 'node:path';
import { generatedPathFor } from '../discover';
import type { SafeDir } from '../discover';
import { findConfig } from '../load/findConfig';
import { loadAllAliases } from '../load/loadAllAliases';
import { parseAndValidateSafeYaml } from '../validate/safeConfigSchema';
import { parseGenerated, type Generated } from './parseGenerated';
import { planSafeConfig } from './planSafeConfig';
import { planSafeDirCalls, type PlanApplyFn } from './planSafeDirCalls';
import { resolveRpcUrl } from './rpc';
import { buildSafeTransaction, initSafe, type SafeInitFn } from './safeApi';
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

  // Role-side: only when the safe-dir declares at least one `.zac.yaml`.
  const generateds: Generated[] =
    opts.safeDir.modifierAddress !== undefined
      ? opts.safeDir.sources.map((src) => parse(generatedPathFor(src)))
      : [];

  const resolveArgs: Parameters<typeof resolveRpcUrl>[0] = { chainId: opts.safeDir.chainId };
  if (opts.rpcUrl !== undefined) resolveArgs.overrideUrl = opts.rpcUrl;
  const rpcUrl = resolveRpcUrl(resolveArgs);

  // Plan role calls only when a modifier exists.
  let roleCalls: Awaited<ReturnType<typeof planSafeDirCalls>> = [];
  if (opts.safeDir.modifierAddress !== undefined) {
    const planArgs: Parameters<typeof planSafeDirCalls>[0] = { generateds };
    if (opts.planApply !== undefined) planArgs.planApply = opts.planApply;
    if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
    if (opts.sdkBuilders !== undefined) planArgs.sdkBuilders = opts.sdkBuilders;
    roleCalls = await planSafeDirCalls(planArgs);
  }

  // Parse `safe.yaml` when present. Render context is `{}` — `aliases` is
  // wired as a global on the nunjucks env, no `params` to inject.
  const parsedSafeYaml =
    opts.safeDir.safeConfigPath !== undefined
      ? (() => {
          const configPath = findConfig({ startDir: opts.safeDir.dirPath });
          const aliases = loadAllAliases({ configPath, network: opts.safeDir.network });
          return parseAndValidateSafeYaml({
            path: opts.safeDir.safeConfigPath,
            aliases: aliases.merged,
            configDir: dirname(configPath),
            network: opts.safeDir.network,
          });
        })()
      : undefined;

  // Short-circuit: no `safe.yaml` AND no role calls → in-sync, no Safe
  // instance needed. Preserves the "safeInit must not be called when 0
  // calls" invariant exercised by TS-11.
  if (parsedSafeYaml === undefined && roleCalls.length === 0) {
    return null;
  }

  // Initialize the Safe instance ONCE — shared by planSafeConfig (live
  // reads) and buildSafeTransaction (calldata bundling) below.
  const initArgs: Parameters<typeof initSafe>[0] = {
    rpcUrl,
    safeAddress: opts.safeDir.safeAddress,
  };
  if (opts.safeInit !== undefined) initArgs.safeInit = opts.safeInit;
  const safe = await initSafe(initArgs);

  // Plan Safe-level calls when `safe.yaml` is present.
  const safeCalls =
    parsedSafeYaml !== undefined
      ? await planSafeConfig({
          safeYaml: parsedSafeYaml,
          safe,
          safeAddress: opts.safeDir.safeAddress,
          declaredModifiers:
            opts.safeDir.modifierAddress !== undefined
              ? [
                  {
                    address: opts.safeDir.modifierAddress,
                    sourceFile: opts.safeDir.sources[0] ?? opts.safeDir.dirPath,
                  },
                ]
              : [],
        })
      : [];

  // Concatenate: Safe-level FIRST, then role calls.
  const allCalls = [...safeCalls, ...roleCalls];
  if (allCalls.length === 0) {
    // Both planners produced nothing — in sync.
    return null;
  }

  const buildArgs: Parameters<typeof buildSafeTransaction>[0] = {
    chainId: opts.safeDir.chainId,
    safeAddress: opts.safeDir.safeAddress,
    calls: allCalls,
    rpcUrl,
    safe,
  };
  if (opts.safeInit !== undefined) buildArgs.safeInit = opts.safeInit;
  const { safeTxHash, safeTxData } = await buildSafeTransaction(buildArgs);

  return {
    calls: allCalls,
    callsCount: allCalls.length,
    chainId: opts.safeDir.chainId,
    // `modifierAddress` is optional on Plan — omit when absent.
    ...(opts.safeDir.modifierAddress !== undefined
      ? { modifierAddress: opts.safeDir.modifierAddress }
      : {}),
    safeAddress: opts.safeDir.safeAddress,
    safeTxData,
    safeTxHash,
  };
}
