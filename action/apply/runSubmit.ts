import { signAndPropose, type SafeApiKitCtor, type SafeInitFn } from './safeApi';
import type { Plan } from './planSchema';

export interface RunSubmitOpts {
  plan: Plan;
  proposerPrivateKey: `0x${string}`;
  apiKey?: string;
  rpcUrl?: string;
  safeInit?: SafeInitFn;
  apiKitCtor?: SafeApiKitCtor;
}

/**
 * Sign + post a pre-computed Plan to Safe Transaction Service. Thin wrapper
 * around `signAndPropose`.
 */
export async function runSubmit(opts: RunSubmitOpts): Promise<{ safeTxHash: string }> {
  const submitArgs: Parameters<typeof signAndPropose>[0] = {
    plan: opts.plan,
    proposerPrivateKey: opts.proposerPrivateKey,
  };
  if (opts.apiKey !== undefined) submitArgs.apiKey = opts.apiKey;
  if (opts.rpcUrl !== undefined) submitArgs.rpcUrl = opts.rpcUrl;
  if (opts.safeInit !== undefined) submitArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) submitArgs.apiKitCtor = opts.apiKitCtor;
  return signAndPropose(submitArgs);
}
