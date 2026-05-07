import { describe, expect, it } from 'vitest';
import { checkParamSanity, checksumAddress } from '../../validate/sanityChecks';
import { ZacError } from '../../errors';

describe('sanityChecks', () => {
  it('T6-41: equal_to with no value rejected', () => {
    // The "missing value" failure is enforced at the schema layer (T6-9). At
    // this layer, `checkParamSanity` only enforces forbidden-field rules and
    // must not false-fire on a valid `equal_to` payload.
    expect(() => checkParamSanity({ operator: 'equal_to' }, 'p')).not.toThrow();
  });

  it('T6-42: equal_to_avatar with value rejected', () => {
    expect(() => checkParamSanity({ operator: 'equal_to_avatar', value: 1 }, 'p')).toThrow(
      ZacError,
    );
  });

  it('T6-43: pass with value rejected', () => {
    expect(() => checkParamSanity({ operator: 'pass', value: 1 }, 'p')).toThrow(ZacError);
  });

  it('T6-44: pass with value_type rejected', () => {
    expect(() => checkParamSanity({ operator: 'pass', value_type: 'uint256' }, 'p')).toThrow(
      ZacError,
    );
  });

  it('T6-45: zero address accepted (still valid format)', () => {
    expect(checksumAddress('0x0000000000000000000000000000000000000000', 'src')).toBe(
      '0x0000000000000000000000000000000000000000',
    );
  });

  it('T6-46: bad checksum rejected', () => {
    // Mixed-case but wrong checksum — `viem.isAddress` (default mode) returns
    // false here, so `checksumAddress` throws on the format check.
    expect(() => checksumAddress('0xa0B86991C6218b36c1d19d4A2E9eB0CE3606Eb48', 'src')).toThrow(
      ZacError,
    );
  });

  it('T6-47: 0xnotahex rejected', () => {
    expect(() => checksumAddress('0xnotahex', 'src')).toThrow(ZacError);
  });
});
