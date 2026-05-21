import { describe, expect, it } from 'vitest';
import { OperatorSchema } from '../../validate/operatorSchemas';

describe('operatorSchemas — leaf', () => {
  it('T6-8: pass valid; with value rejected', () => {
    expect(OperatorSchema.safeParse({ operator: 'pass' }).success).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'pass', value: 1 }).success).toBe(false);
  });

  it('T6-9: equal_to with value+value_type valid; missing value rejected', () => {
    expect(
      OperatorSchema.safeParse({ operator: 'equal_to', value: 1, value_type: 'uint256' }).success,
    ).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'equal_to', value_type: 'uint256' }).success).toBe(
      false,
    );
  });

  it('T6-10: equal_to_avatar without value valid; with value rejected', () => {
    expect(OperatorSchema.safeParse({ operator: 'equal_to_avatar' }).success).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'equal_to_avatar', value: 1 }).success).toBe(false);
  });

  it('T6-11: greater_than requires value_type matching uint*', () => {
    // Schema-level: presence required. The uint*-family check is enforced in
    // dynamicParamSchema (T6-27) — schema only enforces value_type is a
    // non-empty string.
    expect(
      OperatorSchema.safeParse({ operator: 'greater_than', value: 1, value_type: 'uint256' })
        .success,
    ).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'greater_than', value: 1 }).success).toBe(false);
  });

  it('T6-12: less_than requires value_type matching uint*', () => {
    expect(
      OperatorSchema.safeParse({ operator: 'less_than', value: 1, value_type: 'uint256' }).success,
    ).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'less_than', value: 1 }).success).toBe(false);
  });

  it('T6-13: signed_int_greater_than requires int* value_type', () => {
    expect(
      OperatorSchema.safeParse({
        operator: 'signed_int_greater_than',
        value: 1,
        value_type: 'int256',
      }).success,
    ).toBe(true);
    expect(
      OperatorSchema.safeParse({ operator: 'signed_int_greater_than', value: 1 }).success,
    ).toBe(false);
  });

  it('T6-14: signed_int_less_than requires int* value_type', () => {
    expect(
      OperatorSchema.safeParse({
        operator: 'signed_int_less_than',
        value: 1,
        value_type: 'int256',
      }).success,
    ).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'signed_int_less_than', value: 1 }).success).toBe(
      false,
    );
  });

  it('T6-15: oneOf requires non-empty values + value_type', () => {
    expect(
      OperatorSchema.safeParse({ operator: 'oneOf', values: [1, 2], value_type: 'uint256' })
        .success,
    ).toBe(true);
    expect(
      OperatorSchema.safeParse({ operator: 'oneOf', values: [], value_type: 'uint256' }).success,
    ).toBe(false);
    expect(OperatorSchema.safeParse({ operator: 'oneOf', value_type: 'uint256' }).success).toBe(
      false,
    );
  });
});

describe('operatorSchemas — composite', () => {
  const eq = { operator: 'equal_to', value: 1, value_type: 'uint256' };

  it('T6-16: or with conditions valid; empty rejected', () => {
    expect(OperatorSchema.safeParse({ operator: 'or', conditions: [eq, eq] }).success).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'or', conditions: [] }).success).toBe(false);
  });

  it('T6-17: and shape', () => {
    expect(OperatorSchema.safeParse({ operator: 'and', conditions: [eq] }).success).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'and', conditions: [] }).success).toBe(false);
  });

  it('T6-18: nor shape', () => {
    expect(OperatorSchema.safeParse({ operator: 'nor', conditions: [eq] }).success).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'nor', conditions: [] }).success).toBe(false);
  });

  it('T6-19: array_subset shape', () => {
    expect(OperatorSchema.safeParse({ operator: 'array_subset', conditions: [eq] }).success).toBe(
      true,
    );
    expect(OperatorSchema.safeParse({ operator: 'array_subset', conditions: [] }).success).toBe(
      false,
    );
  });

  it('T6-20: matches requires conditions array', () => {
    expect(OperatorSchema.safeParse({ operator: 'matches', conditions: [eq, eq] }).success).toBe(
      true,
    );
    expect(OperatorSchema.safeParse({ operator: 'matches' }).success).toBe(false);
  });

  it('T6-21: array_some with condition valid; with conditions rejected', () => {
    expect(OperatorSchema.safeParse({ operator: 'array_some', condition: eq }).success).toBe(true);
    // Plural `conditions` is rejected by the strict object shape.
    expect(OperatorSchema.safeParse({ operator: 'array_some', conditions: [eq] }).success).toBe(
      false,
    );
    expect(OperatorSchema.safeParse({ operator: 'array_some' }).success).toBe(false);
  });

  it('T6-22: array_every shape', () => {
    expect(OperatorSchema.safeParse({ operator: 'array_every', condition: eq }).success).toBe(true);
    expect(OperatorSchema.safeParse({ operator: 'array_every' }).success).toBe(false);
  });

  it('T6-23: bitmask valid; bad shape rejected', () => {
    expect(
      OperatorSchema.safeParse({ operator: 'bitmask', shift: 0, mask: '0xff', value: '0x0a' })
        .success,
    ).toBe(true);
    expect(
      OperatorSchema.safeParse({ operator: 'bitmask', shift: -1, mask: '0xff', value: '0x0a' })
        .success,
    ).toBe(false);
    expect(
      OperatorSchema.safeParse({ operator: 'bitmask', shift: 0, mask: 'no_hex', value: '0x0a' })
        .success,
    ).toBe(false);
  });

  it('T6-24: deeply nested or(and(eq, eq), nor(eq))', () => {
    const nested = {
      operator: 'or',
      conditions: [
        { operator: 'and', conditions: [eq, eq] },
        { operator: 'nor', conditions: [eq] },
      ],
    };
    expect(OperatorSchema.safeParse(nested).success).toBe(true);
  });

  it('T6-25: unknown operator rejected', () => {
    expect(OperatorSchema.safeParse({ operator: 'unknown_op', value: 1 }).success).toBe(false);
  });
});
