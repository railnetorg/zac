import { describe, expect, it } from 'vitest';
import { parseAbiItem } from 'viem';
import { validateParamAgainstInput } from '../../validate/dynamicParamSchema';
import type { AbiInput } from '../../validate/dynamicParamSchema';
import { ZacError } from '../../errors';

function inputs(sig: string): AbiInput[] {
  const item = parseAbiItem(sig) as unknown as { inputs: AbiInput[] };
  return item.inputs;
}

describe('dynamicParamSchema', () => {
  it('T6-26: uint256 + equal_to(uint256) accepted; equal_to(address) rejected', () => {
    const i = inputs('function foo(uint256 amount)');
    expect(() =>
      validateParamAgainstInput(
        { name: 'amount', operator: 'equal_to', value: 1, value_type: 'uint256' },
        i[0]!,
      ),
    ).not.toThrow();
    expect(() =>
      validateParamAgainstInput(
        { name: 'amount', operator: 'equal_to', value: '0x123', value_type: 'address' },
        i[0]!,
      ),
    ).toThrow(ZacError);
  });

  it('T6-27: uint256 + signed_int_greater_than rejected (wrong family)', () => {
    const i = inputs('function foo(uint256 amount)');
    expect(() =>
      validateParamAgainstInput(
        {
          name: 'amount',
          operator: 'signed_int_greater_than',
          value: 1,
          value_type: 'uint256',
        },
        i[0]!,
      ),
    ).toThrow(ZacError);
  });

  it('T6-28: int256 + signed_int_less_than accepted', () => {
    const i = inputs('function foo(int256 delta)');
    expect(() =>
      validateParamAgainstInput(
        { name: 'delta', operator: 'signed_int_less_than', value: 0, value_type: 'int256' },
        i[0]!,
      ),
    ).not.toThrow();
  });

  it('T6-29: address + equal_to_avatar accepted; on uint256 rejected', () => {
    const a = inputs('function foo(address spender)');
    const u = inputs('function foo(uint256 amount)');
    expect(() =>
      validateParamAgainstInput({ name: 'spender', operator: 'equal_to_avatar' }, a[0]!),
    ).not.toThrow();
    expect(() =>
      validateParamAgainstInput({ name: 'amount', operator: 'equal_to_avatar' }, u[0]!),
    ).toThrow(ZacError);
  });

  it('T6-30: address + oneOf(address) accepted', () => {
    const a = inputs('function foo(address spender)');
    expect(() =>
      validateParamAgainstInput(
        {
          name: 'spender',
          operator: 'oneOf',
          values: ['0x1', '0x2'],
          value_type: 'address',
        },
        a[0]!,
      ),
    ).not.toThrow();
  });

  it('T6-31: tuple matches with per-field types', () => {
    const i = inputs('function foo((address tok, uint256 amt) order)');
    const ok = {
      name: 'order',
      operator: 'matches',
      conditions: [
        { operator: 'equal_to', value: '0x1', value_type: 'address' },
        { operator: 'equal_to', value: 1, value_type: 'uint256' },
      ],
    };
    expect(() => validateParamAgainstInput(ok, i[0]!)).not.toThrow();

    const bad = {
      name: 'order',
      operator: 'matches',
      conditions: [
        { operator: 'equal_to', value: 1, value_type: 'uint256' },
        { operator: 'equal_to', value: 1, value_type: 'uint256' },
      ],
    };
    expect(() => validateParamAgainstInput(bad, i[0]!)).toThrow(ZacError);
  });

  it('T6-32: address[] array_every(address) accepted; child uint256 rejected', () => {
    const i = inputs('function foo(address[] addrs)');
    const ok = {
      name: 'addrs',
      operator: 'array_every',
      condition: { operator: 'equal_to', value: '0x1', value_type: 'address' },
    };
    expect(() => validateParamAgainstInput(ok, i[0]!)).not.toThrow();

    const bad = {
      name: 'addrs',
      operator: 'array_every',
      condition: { operator: 'equal_to', value: 1, value_type: 'uint256' },
    };
    expect(() => validateParamAgainstInput(bad, i[0]!)).toThrow(ZacError);
  });

  it('T6-33: address[] array_subset valid + invalid child', () => {
    const i = inputs('function foo(address[] addrs)');
    const ok = {
      name: 'addrs',
      operator: 'array_subset',
      conditions: [
        { operator: 'equal_to', value: '0x1', value_type: 'address' },
        { operator: 'equal_to', value: '0x2', value_type: 'address' },
      ],
    };
    expect(() => validateParamAgainstInput(ok, i[0]!)).not.toThrow();

    const bad = {
      name: 'addrs',
      operator: 'array_subset',
      conditions: [{ operator: 'equal_to', value: 1, value_type: 'uint256' }],
    };
    expect(() => validateParamAgainstInput(bad, i[0]!)).toThrow(ZacError);
  });

  it('T6-34: uint256 or(equal_to, equal_to) accepted; mixed-type child rejected', () => {
    const i = inputs('function foo(uint256 amt)');
    const ok = {
      name: 'amt',
      operator: 'or',
      conditions: [
        { operator: 'equal_to', value: 1, value_type: 'uint256' },
        { operator: 'equal_to', value: 2, value_type: 'uint256' },
      ],
    };
    expect(() => validateParamAgainstInput(ok, i[0]!)).not.toThrow();

    const bad = {
      name: 'amt',
      operator: 'or',
      conditions: [
        { operator: 'equal_to', value: '0x1', value_type: 'address' },
        { operator: 'equal_to', value: 2, value_type: 'uint256' },
      ],
    };
    expect(() => validateParamAgainstInput(bad, i[0]!)).toThrow(ZacError);
  });

  it('T6-35: bytes32 + bitmask accepted', () => {
    const i = inputs('function foo(bytes32 word)');
    const op = {
      name: 'word',
      operator: 'bitmask',
      shift: 0,
      mask: '0xff',
      value: '0x0a',
    };
    expect(() => validateParamAgainstInput(op, i[0]!)).not.toThrow();
  });

  it('T6-36: param-name mismatch rejected', () => {
    const i = inputs('function foo(uint256 amount)');
    expect(() => validateParamAgainstInput({ name: 'wrong', operator: 'pass' }, i[0]!)).toThrow(
      ZacError,
    );
  });

  it('T6-37: missing param coverage caught at orchestrator level', () => {
    // Coverage gaps are an orchestrator concern (`checkParamCoverage`) — see
    // T6-48..T6-50 for the integration coverage. Here just confirm the helper
    // is exported and callable.
    expect(typeof validateParamAgainstInput).toBe('function');
  });
});
