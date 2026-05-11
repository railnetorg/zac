import { privateKeyToAccount } from 'viem/accounts';
import * as viemChains from 'viem/chains';
import { ZacError } from '../errors';
import { safeServiceUrlForChain } from './safeServiceUrl';
import type { Call } from './planRoleCalls';
import type { Plan, SafeTxData } from './planSchema';

/** Minimal `Safe` shape (subset of `@safe-global/protocol-kit`'s `Safe`). */
interface SafeLike {
  createTransaction(args: { transactions: Call[] }): Promise<SafeTransactionLike>;
  getTransactionHash(tx: SafeTransactionLike): Promise<string>;
  signHash(hash: string): Promise<{ data: string }>;
}

interface SafeTransactionLike {
  data: unknown;
}

interface SafeApiKitLike {
  proposeTransaction(args: {
    safeAddress: string;
    safeTransactionData: unknown;
    safeTxHash: string;
    senderAddress: string;
    senderSignature: string;
  }): Promise<void>;
}

/** Default `Safe.init` factory matching protocol-kit's static method. */
export type SafeInitFn = (config: {
  provider: string;
  signer?: string;
  safeAddress: string;
}) => Promise<SafeLike>;

/** Default `SafeApiKit` constructor matching api-kit's exported class. */
export type SafeApiKitCtor = new (config: {
  chainId: bigint;
  txServiceUrl?: string;
  apiKey?: string;
}) => SafeApiKitLike;

export interface BuildSafeTxOpts {
  chainId: number;
  safeAddress: string;
  calls: Call[];
  /** RPC URL for protocol-kit read-only queries (nonce, etc.). Defaults to viem per-chain default. */
  rpcUrl?: string;
  /** Injected for testability — pass a stub Safe.init function. */
  safeInit?: SafeInitFn;
}

export interface BuildSafeTxResult {
  safeTxHash: string;
  safeTxData: SafeTxData;
}

/**
 * Compute the Safe transaction (hash + raw data) without signing or posting.
 * Used by `runPlan`. Uses protocol-kit so nonce/threshold/etc are pulled from
 * the live Safe contract.
 */
export async function buildSafeTransaction(opts: BuildSafeTxOpts): Promise<BuildSafeTxResult> {
  const rpcUrl = opts.rpcUrl ?? defaultRpcUrlForChain(opts.chainId);
  if (rpcUrl === null) {
    throw new ZacError({
      phase: 'apply',
      message: `no default RPC URL available for chainId ${opts.chainId}; set RPC_URL env var`,
    });
  }

  const safeInit = opts.safeInit ?? (await loadSafeInit());

  let safe: SafeLike;
  try {
    safe = await safeInit({
      provider: rpcUrl,
      safeAddress: opts.safeAddress,
    });
  } catch (err) {
    throw new ZacError({
      phase: 'apply',
      message: `Safe.init failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const safeTransaction = await safe.createTransaction({ transactions: opts.calls });
  const safeTxHash = await safe.getTransactionHash(safeTransaction);
  const safeTxData = safeTransaction.data as SafeTxData;
  return { safeTxHash, safeTxData };
}

export interface SignAndProposeOpts {
  plan: Plan;
  proposerPrivateKey: `0x${string}`;
  apiKey?: string;
  /** RPC URL for protocol-kit (needed to re-init Safe to sign). */
  rpcUrl?: string;
  /** Override Safe Transaction Service URL (default: from per-chain map). */
  txServiceUrl?: string;
  /** Injected for testability. */
  safeInit?: SafeInitFn;
  /** Injected for testability. */
  apiKitCtor?: SafeApiKitCtor;
}

/**
 * Sign `plan.safeTxHash` with the proposer key and post the transaction to
 * Safe Transaction Service. Used by `runSubmit`.
 */
export async function signAndPropose(opts: SignAndProposeOpts): Promise<{ safeTxHash: string }> {
  const txServiceUrl = opts.txServiceUrl ?? safeServiceUrlForChain(opts.plan.chainId);
  if (txServiceUrl === null && opts.apiKey === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: `no Safe Transaction Service URL for chainId ${opts.plan.chainId} and no SAFE_API_KEY set`,
    });
  }

  const rpcUrl = opts.rpcUrl ?? defaultRpcUrlForChain(opts.plan.chainId);
  if (rpcUrl === null) {
    throw new ZacError({
      phase: 'apply',
      message: `no default RPC URL available for chainId ${opts.plan.chainId}; set RPC_URL env var`,
    });
  }

  const proposerAddress = privateKeyToAccount(opts.proposerPrivateKey).address;

  const safeInit = opts.safeInit ?? (await loadSafeInit());
  const ApiKitClass = opts.apiKitCtor ?? (await loadApiKitCtor());

  let safe: SafeLike;
  try {
    safe = await safeInit({
      provider: rpcUrl,
      signer: opts.proposerPrivateKey,
      safeAddress: opts.plan.safeAddress,
    });
  } catch (err) {
    throw new ZacError({
      phase: 'apply',
      message: `Safe.init failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const signature = await safe.signHash(opts.plan.safeTxHash);

  const apiKitConfig: { chainId: bigint; txServiceUrl?: string; apiKey?: string } = {
    chainId: BigInt(opts.plan.chainId),
  };
  if (txServiceUrl !== null) apiKitConfig.txServiceUrl = txServiceUrl;
  if (opts.apiKey !== undefined) apiKitConfig.apiKey = opts.apiKey;
  const apiKit = new ApiKitClass(apiKitConfig);

  try {
    await apiKit.proposeTransaction({
      safeAddress: opts.plan.safeAddress,
      safeTransactionData: opts.plan.safeTxData,
      safeTxHash: opts.plan.safeTxHash,
      senderAddress: proposerAddress,
      senderSignature: signature.data,
    });
  } catch (err) {
    throw new ZacError({
      phase: 'apply',
      message: `Safe Transaction Service propose failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return { safeTxHash: opts.plan.safeTxHash };
}

export interface ProposeOpts {
  chainId: number;
  safeAddress: string;
  calls: Call[];
  proposerPrivateKey: `0x${string}`;
  apiKey?: string;
  rpcUrl?: string;
  txServiceUrl?: string;
  safeInit?: SafeInitFn;
  apiKitCtor?: SafeApiKitCtor;
}

/**
 * Backwards-compatible one-shot helper: build + sign + propose in a single
 * call. Existing T11-* tests still use this entry point. Internally chains
 * `buildSafeTransaction` and `signAndPropose`. `runApply` no longer calls
 * this directly — it goes through `runPlan` + `runSubmit`.
 */
export async function proposeToSafe(opts: ProposeOpts): Promise<{ safeTxHash: string }> {
  const buildOpts: BuildSafeTxOpts = {
    chainId: opts.chainId,
    safeAddress: opts.safeAddress,
    calls: opts.calls,
  };
  if (opts.rpcUrl !== undefined) buildOpts.rpcUrl = opts.rpcUrl;
  if (opts.safeInit !== undefined) buildOpts.safeInit = opts.safeInit;
  const { safeTxHash, safeTxData } = await buildSafeTransaction(buildOpts);

  const plan: Plan = {
    calls: opts.calls,
    callsCount: opts.calls.length,
    chainId: opts.chainId,
    modifierAddress: '0x0000000000000000000000000000000000000000',
    safeAddress: opts.safeAddress,
    safeTxData,
    safeTxHash,
  };

  const submitOpts: SignAndProposeOpts = {
    plan,
    proposerPrivateKey: opts.proposerPrivateKey,
  };
  if (opts.apiKey !== undefined) submitOpts.apiKey = opts.apiKey;
  if (opts.rpcUrl !== undefined) submitOpts.rpcUrl = opts.rpcUrl;
  if (opts.txServiceUrl !== undefined) submitOpts.txServiceUrl = opts.txServiceUrl;
  if (opts.safeInit !== undefined) submitOpts.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) submitOpts.apiKitCtor = opts.apiKitCtor;

  return signAndPropose(submitOpts);
}

function defaultRpcUrlForChain(chainId: number): string | null {
  for (const v of Object.values(viemChains)) {
    if (
      v &&
      typeof v === 'object' &&
      'id' in v &&
      (v as { id: unknown }).id === chainId &&
      'rpcUrls' in v
    ) {
      const rpcs = (v as { rpcUrls?: { default?: { http?: readonly string[] } } }).rpcUrls;
      const http = rpcs?.default?.http;
      if (http && http.length > 0 && typeof http[0] === 'string') return http[0];
    }
  }
  return null;
}

async function loadSafeInit(): Promise<SafeInitFn> {
  const mod = (await import('@safe-global/protocol-kit')) as unknown as {
    default: { init: SafeInitFn };
  };
  return mod.default.init.bind(mod.default);
}

async function loadApiKitCtor(): Promise<SafeApiKitCtor> {
  const mod = (await import('@safe-global/api-kit')) as unknown as { default: SafeApiKitCtor };
  return mod.default;
}
