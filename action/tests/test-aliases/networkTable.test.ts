import { describe, expect, it } from 'vitest';
import {
  chainIdForNetwork,
  isKnownNetworkDirectory,
  networkForDirectory,
  supportedNetworkDirectories,
} from '../../load/networkTable';

describe('networkTable', () => {
  it('T3-6: chainIdForNetwork covers all 9', () => {
    expect(chainIdForNetwork('mainnet')).toBe(1);
    expect(chainIdForNetwork('optimism')).toBe(10);
    expect(chainIdForNetwork('gnosis')).toBe(100);
    expect(chainIdForNetwork('polygon')).toBe(137);
    expect(chainIdForNetwork('bnb')).toBe(56);
    expect(chainIdForNetwork('base')).toBe(8453);
    expect(chainIdForNetwork('arbitrum')).toBe(42161);
    expect(chainIdForNetwork('avalanche')).toBe(43114);
    expect(chainIdForNetwork('sepolia')).toBe(11155111);
  });

  it('T3-7: networkForDirectory known returns id; unknown returns null', () => {
    expect(networkForDirectory('mainnet')).toBe(1);
    expect(networkForDirectory('zksync')).toBeNull();
  });

  it('T3-8: isKnownNetworkDirectory', () => {
    expect(isKnownNetworkDirectory('mainnet')).toBe(true);
    expect(isKnownNetworkDirectory('zksync')).toBe(false);
  });

  it('T3-9: supportedNetworkDirectories returns the full sorted list', () => {
    expect(supportedNetworkDirectories()).toEqual([
      'arbitrum',
      'avalanche',
      'base',
      'bnb',
      'gnosis',
      'mainnet',
      'optimism',
      'polygon',
      'sepolia',
    ]);
  });
});
