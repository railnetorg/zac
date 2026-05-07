import { ZacError } from '../errors';

export interface AbiInput {
  name?: string;
  type: string;
  components?: AbiInput[];
}

interface OperatorObj {
  operator: string;
  [k: string]: unknown;
}

const UINT_OPS = new Set(['equal_to', 'oneOf', 'greater_than', 'less_than', 'pass']);
const INT_OPS = new Set([
  'equal_to',
  'oneOf',
  'signed_int_greater_than',
  'signed_int_less_than',
  'pass',
]);
const ADDRESS_OPS = new Set(['equal_to', 'oneOf', 'equal_to_avatar', 'pass']);
const COMPOSITES_ANY_TYPE = new Set(['or', 'and', 'nor', 'bitmask']);
const ARRAY_OPS = new Set(['array_some', 'array_every', 'array_subset']);
const VALUE_TYPED_OPS = new Set([
  'equal_to',
  'oneOf',
  'greater_than',
  'less_than',
  'signed_int_greater_than',
  'signed_int_less_than',
]);

function familyAllowedFor(abiType: string): Set<string> {
  if (abiType === 'address') return ADDRESS_OPS;
  if (abiType === 'bool') return new Set(['equal_to', 'oneOf', 'pass']);
  if (abiType.startsWith('uint')) return UINT_OPS;
  if (abiType.startsWith('int')) return INT_OPS;
  if (abiType.startsWith('bytes')) return new Set(['equal_to', 'oneOf', 'pass']);
  if (abiType === 'string') return new Set(['equal_to', 'oneOf', 'pass']);
  return new Set(['pass']);
}

/**
 * Validate an operator object against an ABI type. Recurses through composite
 * operators (`or`/`and`/`nor`/`bitmask`) using the same parent type. For tuple
 * params only `matches` (or composites) are accepted at the top of this call;
 * tuple-field recursion is handled in `validateParamAgainstInput`. For array
 * params only `array_*` ops (or composites) are accepted; element-type recursion
 * is also handled in `validateParamAgainstInput`.
 *
 * Throws `ZacError({ phase: 'validate' })` on the first ABI-family violation.
 */
export function validateOperatorAgainstAbi(
  op: OperatorObj,
  abiType: string,
  paramName: string,
): void {
  const operator = op.operator;

  // Tuple param: only `matches` (and any-type composites) allowed.
  if (abiType.startsWith('tuple')) {
    if (operator === 'matches') {
      // Children validated per tuple field by the caller.
      return;
    }
    if (COMPOSITES_ANY_TYPE.has(operator)) {
      recurseComposite(op, abiType, paramName);
      return;
    }
    throw new ZacError({
      phase: 'validate',
      message: `operator '${operator}' not allowed for tuple param '${paramName}'`,
    });
  }

  // Array param: array_* ops and any-type composites allowed.
  if (abiType.endsWith('[]')) {
    if (ARRAY_OPS.has(operator)) {
      // Element-type child validation done by the caller.
      return;
    }
    if (COMPOSITES_ANY_TYPE.has(operator)) {
      recurseComposite(op, abiType, paramName);
      return;
    }
    throw new ZacError({
      phase: 'validate',
      message: `operator '${operator}' not allowed for array param '${paramName}'`,
    });
  }

  // Scalar param.
  const allowed = familyAllowedFor(abiType);
  if (allowed.has(operator)) {
    if (VALUE_TYPED_OPS.has(operator)) {
      const vt = (op as { value_type?: string }).value_type;
      if (vt !== abiType) {
        throw new ZacError({
          phase: 'validate',
          message: `param '${paramName}' (ABI type ${abiType}) requires value_type ${abiType}, got ${vt ?? '<missing>'}`,
        });
      }
    }
    return;
  }
  if (COMPOSITES_ANY_TYPE.has(operator)) {
    recurseComposite(op, abiType, paramName);
    return;
  }
  throw new ZacError({
    phase: 'validate',
    message: `operator '${operator}' not allowed for ${abiType} param '${paramName}'`,
  });
}

function recurseComposite(op: OperatorObj, parentAbiType: string, paramName: string): void {
  if (op.operator === 'bitmask') return; // bitmask is leaf-like, no children to recurse into.
  const conditions = (op as { conditions?: unknown[] }).conditions;
  if (Array.isArray(conditions)) {
    for (const child of conditions) {
      validateOperatorAgainstAbi(child as OperatorObj, parentAbiType, paramName);
    }
  }
}

/**
 * Validate a `params[i]` object (with a `name` field) against a single ABI input.
 * Handles the special-case recursion into tuple components (for `matches`) and
 * array element types (for `array_*`), then delegates the family check to
 * `validateOperatorAgainstAbi`.
 */
export function validateParamAgainstInput(
  param: { name: string; [k: string]: unknown },
  input: AbiInput,
): void {
  if (param.name !== input.name) {
    throw new ZacError({
      phase: 'validate',
      message: `param name mismatch: got '${param.name}', expected '${input.name ?? '<unnamed>'}'`,
    });
  }
  const op = param as unknown as OperatorObj;

  if (op.operator === 'matches' && input.type === 'tuple' && Array.isArray(input.components)) {
    const conditions = (op as { conditions?: unknown[] }).conditions;
    if (!Array.isArray(conditions) || conditions.length !== input.components.length) {
      throw new ZacError({
        phase: 'validate',
        message: `'matches' on tuple param '${input.name ?? ''}' must have ${input.components.length} children`,
      });
    }
    for (let i = 0; i < input.components.length; i++) {
      const component = input.components[i]!;
      validateOperatorAgainstAbi(conditions[i] as OperatorObj, component.type, input.name ?? '');
    }
    return;
  }

  if (input.type.endsWith('[]') && ARRAY_OPS.has(op.operator)) {
    const elementType = input.type.slice(0, -2);
    if (op.operator === 'array_some' || op.operator === 'array_every') {
      const child = (op as { condition?: unknown }).condition;
      if (!child) {
        throw new ZacError({
          phase: 'validate',
          message: `'${op.operator}' missing 'condition' on param '${input.name ?? ''}'`,
        });
      }
      validateOperatorAgainstAbi(child as OperatorObj, elementType, input.name ?? '');
      return;
    }
    if (op.operator === 'array_subset') {
      const conditions = (op as { conditions?: unknown[] }).conditions;
      if (!Array.isArray(conditions)) {
        throw new ZacError({
          phase: 'validate',
          message: `'array_subset' missing 'conditions' on param '${input.name ?? ''}'`,
        });
      }
      for (const c of conditions) {
        validateOperatorAgainstAbi(c as OperatorObj, elementType, input.name ?? '');
      }
      return;
    }
  }

  validateOperatorAgainstAbi(op, input.type, input.name ?? '');
}
