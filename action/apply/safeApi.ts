import { privateKeyToAccount } from 'viem/accounts';
import * as viemChains from 'viem/chains';
import { ZacError } from '../errors';
import { safeServiceUrlForChain } from './safeServiceUrl';
import type { Call } from './planRoleCalls';

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
  signer: string;
  safeAddress: string;
}) => Promise<SafeLike>;

/** Default `SafeApiKit` constructor matching api-kit's exported class. */
export type SafeApiKitCtor = new (config: {
  chainId: bigint;
  txServiceUrl?: string;
  apiKey?: string;
}) => SafeApiKitLike;

export interface ProposeOpts {
  chainId: number;
  safeAddress: string;
  calls: Call[];
  proposerPrivateKey: `0x${string}`;
  apiKey?: string;
  /**
   * RPC URL for the Safe Protocol Kit's read-only on-chain queries (nonce,
   * threshold, etc.). Defaults to viem's per-chain default RPC.
   */
  rpcUrl?: string;
  /** Override Safe Transaction Service URL (default: from per-chain map). */
  txServiceUrl?: string;
  /** Injected for testability — pass a stub Safe.init function. */
  safeInit?: SafeInitFn;
  /** Injected for testability — pass a stub SafeApiKit constructor. */
  apiKitCtor?: SafeApiKitCtor;
}

export async function proposeToSafe(opts: ProposeOpts): Promise<{ safeTxHash: string }> {
  const txServiceUrl = opts.txServiceUrl ?? safeServiceUrlForChain(opts.chainId);
  if (txServiceUrl === null && opts.apiKey === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: `no Safe Transaction Service URL for chainId ${opts.chainId} and no SAFE_API_KEY set`,
    });
  }

  const rpcUrl = opts.rpcUrl ?? defaultRpcUrlForChain(opts.chainId);
  if (rpcUrl === null) {
    throw new ZacError({
      phase: 'apply',
      message: `no default RPC URL available for chainId ${opts.chainId}; set RPC_URL env var`,
    });
  }

  const proposerAddress = privateKeyToAccount(opts.proposerPrivateKey).address;

  // Resolve injected modules or import from packages.
  const safeInit = opts.safeInit ?? (await loadSafeInit());
  const ApiKitClass = opts.apiKitCtor ?? (await loadApiKitCtor());

  let safe: SafeLike;
  try {
    safe = await safeInit({
      provider: rpcUrl,
      signer: opts.proposerPrivateKey,
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
  const signature = await safe.signHash(safeTxHash);

  const apiKitConfig: { chainId: bigint; txServiceUrl?: string; apiKey?: string } = {
    chainId: BigInt(opts.chainId),
  };
  if (txServiceUrl !== null) apiKitConfig.txServiceUrl = txServiceUrl;
  if (opts.apiKey !== undefined) apiKitConfig.apiKey = opts.apiKey;
  const apiKit = new ApiKitClass(apiKitConfig);

  try {
    await apiKit.proposeTransaction({
      safeAddress: opts.safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: proposerAddress,
      senderSignature: signature.data,
    });
  } catch (err) {
    throw new ZacError({
      phase: 'apply',
      message: `Safe Transaction Service propose failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return { safeTxHash };
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
