import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { keccak } from '../../render/keccakFilter';

describe('keccakFilter', () => {
  it('T4-1: keccak("MANAGER") returns the known 32-byte hex', () => {
    expect(keccak('MANAGER')).toBe(
      '0xaf290d8680820aad922855f39b306097b20e28774d6c1ad35a20325630c3a02c',
    );
  });

  it('T4-2: keccak("") returns the empty-string keccak', () => {
    expect(keccak('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });

  it('T4-3: keccak filter is callable from Nunjucks', () => {
    const env = new nunjucks.Environment(undefined, { throwOnUndefined: true });
    env.addFilter('keccak', keccak);
    const out = env.renderString("{{ 'X' | keccak }}", {}).trim();
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
