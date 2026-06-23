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
import { initSafe, type SafeInitFn } from './safeApi';
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

export interface RunPlanForSafeDirOpts {
  safeDir: SafeDir;
  /**
   * CLI `--rpc-url` override, forwarded to `resolveRpcUrl` ONLY when a
   * `safe.yaml` is present (Safe-config planning reads live guard/fallback/
   * module state). Role-only safe-dirs never resolve an RPC.
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
 * Compute the aggregated role-state-update (and Safe-config) `calls` for a
 * whole safe-dir — pure calldata, NO Safe transaction. The aggregated
 * `desired.roles` is the union across every source in `safeDir.sources`;
 * the SDK natively emits revoke calls for any role on the modifier not in
 * the aggregated set (the "revoke unmentioned" default).
 *
 * RPC usage is gated on `safe.yaml`: role calls are planned offline, so a
 * role-only safe-dir needs neither an RPC nor a deployed Safe. A Safe is
 * initialized (and an RPC resolved) ONLY when a `safe.yaml` is present,
 * because Safe-config planning diffs against live guard/fallback/module
 * state. The Safe tx itself is built later, at submit time.
 *
 * Returns `null` when there is nothing to propose — both the role planner
 * and the Safe-config planner produced 0 calls. "In sync" is a SUCCESS
 * condition; the caller decides how to surface it (the CLI prints a
 * one-liner and skips the plan-file write).
 */
export async function runPlanForSafeDir(opts: RunPlanForSafeDirOpts): Promise<Plan | null> {
  const parse = opts.parseGenerated ?? parseGenerated;

  // Role-side: only when the safe-dir declares at least one `.zac.yaml`.
  const generateds: Generated[] =
    opts.safeDir.modifierAddress !== undefined
      ? opts.safeDir.sources.map((src) => parse(generatedPathFor(src)))
      : [];

  // Plan role calls only when a modifier exists. RPC-free — `planSafeDirCalls`
  // reads no chain state.
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
  // instance needed (preserves the RPC-free role-only path).
  if (parsedSafeYaml === undefined && roleCalls.length === 0) {
    return null;
  }

  // Safe-config calls are planned ONLY when a `safe.yaml` is present — that
  // is the sole branch that needs a live Safe (guard/fallback/module reads),
  // so the RPC + Safe.init are gated here rather than run unconditionally.
  let safeCalls: Awaited<ReturnType<typeof planSafeConfig>> = [];
  if (parsedSafeYaml !== undefined) {
    const resolveArgs: Parameters<typeof resolveRpcUrl>[0] = { chainId: opts.safeDir.chainId };
    if (opts.rpcUrl !== undefined) resolveArgs.overrideUrl = opts.rpcUrl;
    const rpcUrl = resolveRpcUrl(resolveArgs);

    const initArgs: Parameters<typeof initSafe>[0] = {
      rpcUrl,
      safeAddress: opts.safeDir.safeAddress,
    };
    if (opts.safeInit !== undefined) initArgs.safeInit = opts.safeInit;
    const safe = await initSafe(initArgs);

    safeCalls = await planSafeConfig({
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
    });
  }

  // Concatenate: Safe-level FIRST, then role calls.
  const allCalls = [...safeCalls, ...roleCalls];
  if (allCalls.length === 0) {
    // Both planners produced nothing — in sync.
    return null;
  }

  return {
    calls: allCalls,
    callsCount: allCalls.length,
    chainId: opts.safeDir.chainId,
    // `modifierAddress` is optional on Plan — omit when absent.
    ...(opts.safeDir.modifierAddress !== undefined
      ? { modifierAddress: opts.safeDir.modifierAddress }
      : {}),
    safeAddress: opts.safeDir.safeAddress,
  };
}
