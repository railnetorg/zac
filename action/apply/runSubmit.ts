import { ZacError } from '../errors';
import { resolveRpcUrl } from './rpc';
import {
  buildSafeTransaction,
  signAndPropose,
  type SafeApiKitCtor,
  type SafeInitFn,
} from './safeApi';
import type { Plan, SafeTxData } from './planSchema';

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

export interface SubmitResult {
  safeTxHash: string;
  /**
   * The exact `SafeTxData` that was posted to Safe Transaction Service —
   * always freshly computed here from the plan's `calls` against the live
   * Safe (nonce, threshold). The plan itself carries no Safe tx. Downstream
   * tooling (the release-body / submit-log renderer) uses this to surface
   * `nonce` / `operation` / `messageHash` to signers.
   */
  safeTxData: SafeTxData;
  /** Number of underlying calls inside the proposed Safe tx. */
  callsCount: number;
}

/**
 * Build the Safe transaction for a single plan's calls against the live Safe
 * and post it to the Safe Transaction Service. Thin wrapper over
 * `runBundledSubmit`.
 */
export async function runSubmit(opts: RunSubmitOpts): Promise<SubmitResult> {
  const bundledArgs: Parameters<typeof runBundledSubmit>[0] = {
    plans: [opts.plan],
    proposerPrivateKey: opts.proposerPrivateKey,
  };
  if (opts.apiKey !== undefined) bundledArgs.apiKey = opts.apiKey;
  if (opts.rpcUrl !== undefined) bundledArgs.rpcUrl = opts.rpcUrl;
  if (opts.safeInit !== undefined) bundledArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) bundledArgs.apiKitCtor = opts.apiKitCtor;
  return runBundledSubmit(bundledArgs);
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
 * MultiSend when N>1 by protocol-kit), built against the live Safe (nonce,
 * threshold), and post it to the Safe Transaction Service. All plans must
 * share the same `safeAddress` and `chainId`.
 *
 * This is the sole place a Safe tx is built — `plan` produces only calldata,
 * so the live-Safe read happens here at submit time, not at plan time.
 */
export async function runBundledSubmit(opts: RunBundledSubmitOpts): Promise<SubmitResult> {
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

  const submitArgs: Parameters<typeof signAndPropose>[0] = {
    safeAddress: first.safeAddress,
    chainId: first.chainId,
    safeTxData,
    safeTxHash,
    proposerPrivateKey: opts.proposerPrivateKey,
    rpcUrl,
  };
  if (opts.apiKey !== undefined) submitArgs.apiKey = opts.apiKey;
  if (opts.safeInit !== undefined) submitArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) submitArgs.apiKitCtor = opts.apiKitCtor;
  await signAndPropose(submitArgs);

  return { safeTxHash, safeTxData, callsCount: calls.length };
}
