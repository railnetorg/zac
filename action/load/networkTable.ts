export const NETWORKS = {
  mainnet: 1,
  optimism: 10,
  gnosis: 100,
  polygon: 137,
  bnb: 56,
  base: 8453,
  arbitrum: 42161,
  avalanche: 43114,
  sepolia: 11155111,
} as const;

export type NetworkName = keyof typeof NETWORKS;

export function chainIdForNetwork(name: NetworkName): number {
  return NETWORKS[name];
}

/** Returns chain_id for a directory name, or null if unknown. */
export function networkForDirectory(name: string): number | null {
  if (Object.prototype.hasOwnProperty.call(NETWORKS, name)) {
    return NETWORKS[name as NetworkName];
  }
  return null;
}

export function isKnownNetworkDirectory(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NETWORKS, name);
}

export function supportedNetworkDirectories(): string[] {
  return Object.keys(NETWORKS).sort();
}
