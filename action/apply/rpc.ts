import { ZacError } from '../errors';
import { NETWORKS, type NetworkName } from '../load/networkTable';

/**
 * Build the per-chain env var name for a chainId, or `null` if the chainId is
 * not in the NETWORKS table.
 *
 * E.g. chainId 1 → `MAINNET_RPC_URL`, chainId 8453 → `BASE_RPC_URL`.
 */
function perChainEnvVarFor(chainId: number): string | null {
  for (const [name, id] of Object.entries(NETWORKS)) {
    if (id === chainId) return `${(name as NetworkName).toUpperCase()}_RPC_URL`;
  }
  return null;
}

export interface ResolveRpcUrlOpts {
  chainId: number;
  /** CLI `--rpc-url` flag value; takes priority over any env var when set. */
  overrideUrl?: string;
}

/**
 * Resolve an RPC URL for a given chainId. Priority (first match wins):
 *   1. `overrideUrl` (the CLI `--rpc-url` flag, passed by callers).
 *   2. `<NETWORK>_RPC_URL` env var for the chainId's network (e.g.
 *      `MAINNET_RPC_URL`, `BASE_RPC_URL`). Skipped if the chainId is not in
 *      the NETWORKS table.
 *   3. `RPC_URL` env var (universal fallback).
 *
 * If none of the above produces a value, throws `ZacError(phase: 'apply')`
 * naming the chainId and the env vars that were checked so the user knows
 * what to set.
 */
export function resolveRpcUrl(opts: ResolveRpcUrlOpts): string {
  if (opts.overrideUrl !== undefined && opts.overrideUrl !== '') {
    return opts.overrideUrl;
  }

  const perChainVar = perChainEnvVarFor(opts.chainId);
  if (perChainVar !== null) {
    const perChain = process.env[perChainVar];
    if (perChain !== undefined && perChain !== '') return perChain;
  }

  const universal = process.env['RPC_URL'];
  if (universal !== undefined && universal !== '') return universal;

  const checked =
    perChainVar !== null
      ? `${perChainVar} (per-chain), RPC_URL (universal)`
      : `RPC_URL (universal)`;
  throw new ZacError({
    phase: 'apply',
    message: `no RPC URL configured for chainId ${opts.chainId}; checked: ${checked}`,
  });
}
