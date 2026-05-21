import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRpcUrl } from '../../apply/rpc';
import { ZacError } from '../../errors';

// Per-chainId env var names mirror NETWORKS in `action/load/networkTable.ts`.
// Anything matching this prefix gets cleared before each test to prevent
// ambient `RPC_URL` / `<NETWORK>_RPC_URL` from the host shell leaking in.
const RPC_ENV_VARS = [
  'RPC_URL',
  'MAINNET_RPC_URL',
  'OPTIMISM_RPC_URL',
  'GNOSIS_RPC_URL',
  'POLYGON_RPC_URL',
  'BNB_RPC_URL',
  'BASE_RPC_URL',
  'ARBITRUM_RPC_URL',
  'AVALANCHE_RPC_URL',
  'SEPOLIA_RPC_URL',
];

describe('resolveRpcUrl', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of RPC_ENV_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of RPC_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('TR-1: overrideUrl wins over both per-chain and universal env vars', () => {
    process.env['MAINNET_RPC_URL'] = 'http://per-chain/main';
    process.env['RPC_URL'] = 'http://universal/any';
    expect(resolveRpcUrl({ chainId: 1, overrideUrl: 'http://override/cli' })).toBe(
      'http://override/cli',
    );
  });

  it('TR-2: per-chain env var (e.g. BASE_RPC_URL for chainId 8453) wins over universal RPC_URL', () => {
    process.env['BASE_RPC_URL'] = 'http://per-chain/base';
    process.env['RPC_URL'] = 'http://universal/any';
    expect(resolveRpcUrl({ chainId: 8453 })).toBe('http://per-chain/base');
  });

  it('TR-3: universal RPC_URL is used when the per-chain env var is not set', () => {
    process.env['RPC_URL'] = 'http://universal/any';
    expect(resolveRpcUrl({ chainId: 1 })).toBe('http://universal/any');
  });

  it('TR-4: no source set → ZacError(phase=apply) names the chainId and the env vars checked', () => {
    try {
      resolveRpcUrl({ chainId: 8453 });
      throw new Error('expected resolveRpcUrl to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      const err = e as ZacError;
      expect(err.phase).toBe('apply');
      expect(err.message).toContain('8453');
      expect(err.message).toContain('BASE_RPC_URL');
      expect(err.message).toContain('RPC_URL');
    }
  });

  it('TR-5: unknown chainId falls through to universal RPC_URL only (no per-chain step)', () => {
    process.env['RPC_URL'] = 'http://universal/any';
    expect(resolveRpcUrl({ chainId: 999_999 })).toBe('http://universal/any');
  });

  it('TR-6: unknown chainId with no RPC_URL → ZacError mentions only RPC_URL (no per-chain var)', () => {
    try {
      resolveRpcUrl({ chainId: 999_999 });
      throw new Error('expected resolveRpcUrl to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      const err = e as ZacError;
      expect(err.phase).toBe('apply');
      expect(err.message).toContain('999999');
      expect(err.message).toContain('RPC_URL');
      // Per-chain variant should NOT be mentioned for unknown chainIds.
      expect(err.message).not.toMatch(/[A-Z]+_RPC_URL \(per-chain\)/);
    }
  });

  it('TR-7: each known network maps to its expected env var name', () => {
    const cases: Array<[number, string, string]> = [
      [1, 'MAINNET_RPC_URL', 'http://m'],
      [10, 'OPTIMISM_RPC_URL', 'http://o'],
      [56, 'BNB_RPC_URL', 'http://bnb'],
      [100, 'GNOSIS_RPC_URL', 'http://g'],
      [137, 'POLYGON_RPC_URL', 'http://p'],
      [8453, 'BASE_RPC_URL', 'http://b'],
      [42161, 'ARBITRUM_RPC_URL', 'http://a'],
      [43114, 'AVALANCHE_RPC_URL', 'http://av'],
      [11155111, 'SEPOLIA_RPC_URL', 'http://s'],
    ];
    for (const [chainId, envVar, url] of cases) {
      process.env[envVar] = url;
      expect(resolveRpcUrl({ chainId })).toBe(url);
      delete process.env[envVar];
    }
  });

  it('TR-8: empty overrideUrl is treated as unset (env fallback applies)', () => {
    process.env['MAINNET_RPC_URL'] = 'http://per-chain/main';
    expect(resolveRpcUrl({ chainId: 1, overrideUrl: '' })).toBe('http://per-chain/main');
  });

  it('TR-9: empty per-chain env var is treated as unset (universal fallback applies)', () => {
    process.env['MAINNET_RPC_URL'] = '';
    process.env['RPC_URL'] = 'http://universal/any';
    expect(resolveRpcUrl({ chainId: 1 })).toBe('http://universal/any');
  });
});
