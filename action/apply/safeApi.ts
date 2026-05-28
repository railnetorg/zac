import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ZacError } from '../errors';
import { safeServiceUrlForChain } from './safeServiceUrl';
import type { Call } from './planRoleCalls';
import type { Plan, SafeTxData } from './planSchema';

/**
 * Minimal `Safe` shape (subset of `@safe-global/protocol-kit`'s `Safe`).
 *
 * The 7 new methods (3 getters + 4 tx-builders) are OPTIONAL so existing
 * unit-test stubs (e.g. `safeInitStub` in `runPlanForSafeDir.test.ts`,
 * `runBundledSubmit.test.ts`) continue to satisfy `SafeLike` without
 * implementing them. Runtime callers (`planSafeConfig`) check presence
 * and throw `ZacError('apply', 'internal: Safe instance missing <method>')`
 * when a method is needed but absent — that path is only reached when a
 * `safe.yaml` is present, so fixtures lacking safe.yaml never trigger it.
 */
export interface SafeLike {
  createTransaction(args: { transactions: Call[] }): Promise<SafeTransactionLike>;
  getTransactionHash(tx: SafeTransactionLike): Promise<string>;
  signHash(hash: string): Promise<{ data: string }>;
  getGuard?(): Promise<string>;
  getFallbackHandler?(): Promise<string>;
  getModules?(): Promise<string[]>;
  createEnableGuardTx?(address: string): Promise<SafeTransactionLike>;
  createEnableFallbackHandlerTx?(address: string): Promise<SafeTransactionLike>;
  createEnableModuleTx?(address: string): Promise<SafeTransactionLike>;
  createDisableModuleTx?(address: string): Promise<SafeTransactionLike>;
}

export interface SafeTransactionLike {
  data: { to: string; value: string; data: string; operation?: number };
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
  /**
   * RPC URL for protocol-kit read-only queries (nonce, etc.). Required —
   * production callers pre-resolve via `resolveRpcUrl` (which throws if
   * unresolvable).
   */
  rpcUrl: string;
  /** Injected for testability — pass a stub Safe.init function. */
  safeInit?: SafeInitFn;
  /**
   * Pre-initialized `Safe` instance to reuse instead of calling `safeInit`
   * internally. `runPlanForSafeDir` shares one instance across
   * `planSafeConfig` (live-state reads) and `buildSafeTransaction`
   * (calldata-bundling) so a single Safe.init covers both phases. When
   * provided, `safeInit` is ignored.
   */
  safe?: SafeLike;
}

/**
 * Initialize a `Safe` instance (via injected or lazy-loaded `Safe.init`),
 * propagating failures as `ZacError(phase='apply')`. Exported so callers
 * who need to share one instance across multiple SDK calls
 * (`planSafeConfig` reads guard/fallback/modules, then
 * `buildSafeTransaction` bundles calldata) can do so explicitly.
 */
export async function initSafe(opts: {
  rpcUrl: string;
  safeAddress: string;
  safeInit?: SafeInitFn;
}): Promise<SafeLike> {
  const safeInit = opts.safeInit ?? (await loadSafeInit());
  try {
    return await safeInit({
      provider: opts.rpcUrl,
      safeAddress: opts.safeAddress,
    });
  } catch (err) {
    throw new ZacError({
      phase: 'apply',
      message: `Safe.init failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
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
  // Reuse a caller-provided Safe instance when present (so planSafeConfig
  // and this bundler share one Safe.init); otherwise initialize ourselves.
  const initArgs: Parameters<typeof initSafe>[0] = {
    rpcUrl: opts.rpcUrl,
    safeAddress: opts.safeAddress,
  };
  if (opts.safeInit !== undefined) initArgs.safeInit = opts.safeInit;
  const safe: SafeLike = opts.safe ?? (await initSafe(initArgs));

  const safeTransaction = await safe.createTransaction({ transactions: opts.calls });
  const safeTxHash = await safe.getTransactionHash(safeTransaction);
  // protocol-kit's `safeTransaction.data` carries the full SafeTxData shape
  // (baseGas, gasPrice, nonce, etc.); the local `SafeTransactionLike.data`
  // type narrows to the subset planSafeConfig needs to read for Safe-level
  // calldata. Double-cast through unknown to bridge the two views.
  const safeTxData = safeTransaction.data as unknown as SafeTxData;
  return { safeTxHash, safeTxData };
}

export interface SignAndProposeOpts {
  plan: Plan;
  proposerPrivateKey: `0x${string}`;
  apiKey?: string;
  /**
   * RPC URL for protocol-kit (needed to re-init Safe to sign). Required —
   * production callers pre-resolve via `resolveRpcUrl`.
   */
  rpcUrl: string;
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

  const proposerAddress = privateKeyToAccount(opts.proposerPrivateKey).address;

  const safeInit = opts.safeInit ?? (await loadSafeInit());
  const ApiKitClass = opts.apiKitCtor ?? (await loadApiKitCtor());

  let safe: SafeLike;
  try {
    safe = await safeInit({
      provider: opts.rpcUrl,
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
    // Safe Tx Service rejects non-EIP-55 addresses with "Checksum address
    // validation failed". `Plan.safeAddress` is lowercased to match the
    // on-disk safe-dir naming convention (see `discover.ts`), so checksum
    // it here at the API boundary.
    await apiKit.proposeTransaction({
      safeAddress: getAddress(opts.plan.safeAddress),
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
