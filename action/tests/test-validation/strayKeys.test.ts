import { describe, expect, it } from 'vitest';
import {
  ABI_ENCODED_CHILD_KEYS,
  ABI_ENCODED_PARAM_KEYS,
  BRANCH_KEYS,
  FUNCTION_KEYS,
  ROLE_KEYS,
  checkNoStrayKeys,
} from '../../validate/strayKeys';
import { ZacError } from '../../errors';

describe('checkNoStrayKeys', () => {
  it('SK-1: a node using only allowed keys passes, and so does an empty one', () => {
    expect(() => checkNoStrayKeys({ address: '0x0', functions: [] }, ROLE_KEYS, 'r')).not.toThrow();
    // A subset is fine — every one of these vocabularies has optional keys.
    expect(() => checkNoStrayKeys({ signature: 'f()' }, FUNCTION_KEYS, 'f')).not.toThrow();
    expect(() => checkNoStrayKeys({}, ROLE_KEYS, 'r')).not.toThrow();
  });

  it('SK-2: a stray key is rejected, and the message names it, the position and the set', () => {
    let caught: unknown;
    try {
      checkNoStrayKeys(
        { signature: 'f()', execution_option: 'send' },
        FUNCTION_KEYS,
        'a.tmpl f[0]',
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZacError);
    expect((caught as ZacError).phase).toBe('validate');
    expect((caught as ZacError).message).toBe(
      "unknown key 'execution_option' at a.tmpl f[0] — allowed: " +
        'signature, execution_options, params, operator, branches',
    );
  });

  it('SK-3: several stray keys are all named, pluralized', () => {
    expect(() => checkNoStrayKeys({ a: 1, b: 2 }, BRANCH_KEYS, 'b')).toThrow(
      /unknown keys 'a', 'b' at b — allowed: operator, params/,
    );
  });

  it('SK-4: a node that is not a mapping is rejected rather than skipped', () => {
    // A template can render `functions:` to a scalar or a list of scalars as
    // easily as to a mapping, and a check that only looked at `Object.keys`
    // would let both through — `Object.keys('x')` is the string's indices.
    const cases: Array<[unknown, string]> = [
      [null, 'null'],
      [undefined, 'undefined'],
      [[], 'a list'],
      ['send', 'string'],
      [7, 'number'],
    ];
    for (const [value, shape] of cases) {
      expect(() => checkNoStrayKeys(value, ROLE_KEYS, 'r')).toThrow(
        `r must be a mapping, got ${shape}`,
      );
    }
  });

  it('SK-5: the vocabularies are the ones the pipeline reads', () => {
    // Pinned as literals rather than derived, so widening a vocabulary is a
    // deliberate edit here as well as at the reader. Each of these keys is
    // read somewhere: `runValidate` for the first three, `renderParamTree`
    // and `abiTypeOfChild` for the abi_encoded pair.
    expect([...ROLE_KEYS]).toEqual(['address', 'functions']);
    expect([...FUNCTION_KEYS]).toEqual([
      'signature',
      'execution_options',
      'params',
      'operator',
      'branches',
    ]);
    expect([...BRANCH_KEYS]).toEqual(['operator', 'params']);
    expect([...ABI_ENCODED_PARAM_KEYS]).toEqual(['name', 'param_type', 'children']);
    // A nested blob adds `value_type`: it is what gives the child slot its
    // ABI type instead of defaulting to `bytes`.
    expect([...ABI_ENCODED_CHILD_KEYS]).toEqual(['name', 'param_type', 'children', 'value_type']);
  });
});
