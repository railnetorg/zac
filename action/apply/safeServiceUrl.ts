/**
 * Per-chain map of public Safe Transaction Service URLs.
 *
 * api-kit 4.x requires either an `apiKey` (for the unified `api.safe.global`
 * gateway) OR an explicit `txServiceUrl`. We use the explicit URL approach so
 * `zac apply` works without forcing every user to register a Safe API key.
 *
 * If users hit rate limits they can set `SAFE_API_KEY` and we will honor it
 * (api-kit then routes through `api.safe.global`).
 *
 * The 9 chains here mirror the v2 NETWORKS list (§9.57). Adding a new chain:
 * 1. Add an entry below.
 * 2. Add the directory under `examples/<network>/`.
 * 3. Add an alias bundle entry in `aliases/networks.yaml`.
 */
const SAFE_TX_SERVICE_URLS: Record<number, string> = {
  1: 'https://safe-transaction-mainnet.safe.global/api',
  10: 'https://safe-transaction-optimism.safe.global/api',
  56: 'https://safe-transaction-bsc.safe.global/api',
  100: 'https://safe-transaction-gnosis-chain.safe.global/api',
  137: 'https://safe-transaction-polygon.safe.global/api',
  8453: 'https://safe-transaction-base.safe.global/api',
  42161: 'https://safe-transaction-arbitrum.safe.global/api',
  43114: 'https://safe-transaction-avalanche.safe.global/api',
  11155111: 'https://safe-transaction-sepolia.safe.global/api',
};

export function safeServiceUrlForChain(chainId: number): string | null {
  return SAFE_TX_SERVICE_URLS[chainId] ?? null;
}
