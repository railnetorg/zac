import { describe, expect, it } from 'vitest';
import { makeAliasEnv } from '../../load/aliasEnv';

describe('aliasEnv', () => {
  it('T3-14: alias self-reference {{ aliases.foo }} throws', () => {
    const env = makeAliasEnv();
    expect(() => env.renderString('{{ aliases.foo }}', {})).toThrow();
  });

  it('T3-15: keccak filter returns correct hash for "MANAGER"', () => {
    const env = makeAliasEnv();
    const out = env.renderString("{{ 'MANAGER' | keccak }}", {}).trim();
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out).toBe('0xaf290d8680820aad922855f39b306097b20e28774d6c1ad35a20325630c3a02c');
  });
});
