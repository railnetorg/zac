import { describe, expect, it } from 'vitest';
import { parseSignature } from '../../validate/signatureValidation';
import { ZacError } from '../../errors';

describe('signatureValidation', () => {
  it('T6-38: named inputs parse cleanly', () => {
    const fn = parseSignature('function approve(address spender, uint256 amount)');
    expect(fn.inputs.length).toBe(2);
    expect(fn.inputs[0]!.name).toBe('spender');
    expect(fn.inputs[1]!.name).toBe('amount');
  });

  it('T6-39: unnamed input throws with §9.11 message', () => {
    expect(() => parseSignature('function approve(address, uint256)')).toThrow(ZacError);
    try {
      parseSignature('function approve(address, uint256)');
    } catch (e) {
      expect((e as ZacError).message).toContain('§9.11');
      expect((e as ZacError).message).toContain('unnamed parameter');
    }
  });

  it('T6-40: malformed signature throws', () => {
    expect(() => parseSignature('function approve(...')).toThrow(ZacError);
  });
});
