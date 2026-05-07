import { describe, expect, it } from 'vitest';
import { chainIdInViem, checkNetwork } from '../../load/networkCheck';
import { ZacError } from '../../errors';

describe('networkCheck', () => {
  it('T3-10: mainnet + chain_id 1 = no error', () => {
    expect(() => checkNetwork({ directoryName: 'mainnet', declaredChainId: 1 })).not.toThrow();
  });

  it('T3-11: dir/chain mismatch error contains both', () => {
    try {
      checkNetwork({ directoryName: 'mainnet', declaredChainId: 137 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      const msg = (e as ZacError).message;
      expect(msg).toContain("'mainnet'");
      expect(msg).toContain('137');
      expect(msg).toContain('1');
    }
  });

  it('T3-12: unknown dir error contains supported list', () => {
    try {
      checkNetwork({ directoryName: 'goerli', declaredChainId: 5 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      const msg = (e as ZacError).message;
      expect(msg).toContain("'goerli'");
      expect(msg).toContain('mainnet');
      expect(msg).toContain('optimism');
    }
  });

  it('T3-13: chain_id 99999 (not in viem/chains) errors; chainIdInViem distinguishes registered vs unregistered', () => {
    // The closed NETWORKS table is constructed only from chain_ids known to viem/chains, so the
    // (a) directory↔table check fires first for a 99999 declaration, with a message that mentions
    // 99999 and the directory's expected chain_id. We assert that here, then assert chainIdInViem
    // directly to cover the (b) code path.
    try {
      checkNetwork({ directoryName: 'mainnet', declaredChainId: 99999 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).message).toContain('99999');
    }
    expect(chainIdInViem(1)).toBe(true);
    expect(chainIdInViem(99999)).toBe(false);
  });
});
