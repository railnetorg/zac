import { describe, expect, it } from 'vitest';
import { PARAM_TYPES, checkParamType } from '../../validate/paramTypeSchema';
import { ZacError } from '../../errors';

describe('checkParamType', () => {
  it('PT-1: every value in the taxonomy is accepted, and so is omitting the key', () => {
    for (const value of [undefined, ...PARAM_TYPES]) {
      expect(() => checkParamType(value, 'p')).not.toThrow();
    }
  });

  it('PT-2: a misspelling is rejected with the value, the position and the allowed set', () => {
    let caught: unknown;
    try {
      checkParamType('dynammic', "a.tmpl roles[0].functions[0].params[2] ('data')");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZacError);
    expect((caught as ZacError).phase).toBe('validate');
    expect((caught as ZacError).message).toBe(
      'param_type "dynammic" at a.tmpl roles[0].functions[0].params[2] (\'data\') ' +
        'is not one of static | dynamic | tuple | abi_encoded',
    );
  });

  it('PT-3: a wrong-case value is rejected — the taxonomy is lowercase', () => {
    expect(() => checkParamType('Static', 'p')).toThrow(ZacError);
  });

  it('PT-4: an empty string is rejected — it is not the same as omitting the key', () => {
    expect(() => checkParamType('', 'p')).toThrow(ZacError);
  });

  it('PT-5: a non-string is rejected', () => {
    for (const value of [null, 0, true, [], {}]) {
      expect(() => checkParamType(value, 'p')).toThrow(ZacError);
    }
  });
});
