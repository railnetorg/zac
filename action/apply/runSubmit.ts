import { ZacError } from '../errors';
import { resolveRpcUrl } from './rpc';
import {
  buildSafeTransaction,
  signAndPropose,
  type SafeApiKitCtor,
  type SafeInitFn,
} from './safeApi';
import type { Plan } from './planSchema';

export interface RunSubmitOpts {
  plan: Plan;
  proposerPrivateKey: `0x${string}`;
  apiKey?: string;
  /**
   * CLI `--rpc-url` override. When omitted, the URL is resolved per-chain
   * via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`) with `RPC_URL` as the
   * universal fallback. See `resolveRpcUrl`.
   */
  rpcUrl?: string;
  safeInit?: SafeInitFn;
  apiKitCtor?: SafeApiKitCtor;
}

/**
 * Sign + post a pre-computed Plan to Safe Transaction Service. Thin wrapper
 * around `signAndPropose`.
 */
export async function runSubmit(opts: RunSubmitOpts): Promise<{ safeTxHash: string }> {
  const resolveArgs: Parameters<typeof resolveRpcUrl>[0] = { chainId: opts.plan.chainId };
  if (opts.rpcUrl !== undefined) resolveArgs.overrideUrl = opts.rpcUrl;
  const rpcUrl = resolveRpcUrl(resolveArgs);

  const submitArgs: Parameters<typeof signAndPropose>[0] = {
    plan: opts.plan,
    proposerPrivateKey: opts.proposerPrivateKey,
    rpcUrl,
  };
  if (opts.apiKey !== undefined) submitArgs.apiKey = opts.apiKey;
  if (opts.safeInit !== undefined) submitArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) submitArgs.apiKitCtor = opts.apiKitCtor;
  return signAndPropose(submitArgs);
}

export interface RunBundledSubmitOpts {
  /** Non-empty array of plans assumed to share `(safeAddress, chainId)`. */
  plans: Plan[];
  proposerPrivateKey: `0x${string}`;
  apiKey?: string;
  /**
   * CLI `--rpc-url` override. When omitted, the URL is resolved per-chain
   * via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`) with `RPC_URL` as the
   * universal fallback. See `resolveRpcUrl`.
   */
  rpcUrl?: string;
  safeInit?: SafeInitFn;
  apiKitCtor?: SafeApiKitCtor;
}

/**
 * Bundle every plan's `calls[]` into ONE Safe transaction (auto-wrapped in
 * MultiSend when N>1 by protocol-kit) and post it to Safe Transaction
 * Service. All plans must share the same `safeAddress` and `chainId`.
 *
 * The bundled `safeTxData` and `safeTxHash` are recomputed from the live
 * Safe contract (nonce, threshold) — the stored per-plan hashes are NOT
 * reused.
 */
export async function runBundledSubmit(
  opts: RunBundledSubmitOpts,
): Promise<{ safeTxHash: string }> {
  if (opts.plans.length === 0) {
    throw new ZacError({
      phase: 'apply',
      message: 'runBundledSubmit requires at least one plan',
    });
  }
  const first = opts.plans[0]!;
  for (const p of opts.plans) {
    if (p.safeAddress !== first.safeAddress || p.chainId !== first.chainId) {
      throw new ZacError({
        phase: 'apply',
        message: `runBundledSubmit: all plans must share safeAddress+chainId (got ${p.safeAddress}@${p.chainId} vs ${first.safeAddress}@${first.chainId})`,
      });
    }
  }

  const calls = opts.plans.flatMap((p) => p.calls);

  const resolveArgs: Parameters<typeof resolveRpcUrl>[0] = { chainId: first.chainId };
  if (opts.rpcUrl !== undefined) resolveArgs.overrideUrl = opts.rpcUrl;
  const rpcUrl = resolveRpcUrl(resolveArgs);

  const buildArgs: Parameters<typeof buildSafeTransaction>[0] = {
    chainId: first.chainId,
    safeAddress: first.safeAddress,
    calls,
    rpcUrl,
  };
  if (opts.safeInit !== undefined) buildArgs.safeInit = opts.safeInit;
  const { safeTxHash, safeTxData } = await buildSafeTransaction(buildArgs);

  const bundledPlan: Plan = {
    calls,
    callsCount: calls.length,
    chainId: first.chainId,
    // `modifierAddress` is OPTIONAL on Plan — conditionally spread so
    // safe-only bundled plans (no role-modifier touchpoint) serialize
    // without the field.
    ...(first.modifierAddress !== undefined ? { modifierAddress: first.modifierAddress } : {}),
    safeAddress: first.safeAddress,
    safeTxData,
    safeTxHash,
  };

  const submitArgs: Parameters<typeof signAndPropose>[0] = {
    plan: bundledPlan,
    proposerPrivateKey: opts.proposerPrivateKey,
    rpcUrl,
  };
  if (opts.apiKey !== undefined) submitArgs.apiKey = opts.apiKey;
  if (opts.safeInit !== undefined) submitArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) submitArgs.apiKitCtor = opts.apiKitCtor;
  return signAndPropose(submitArgs);
}
