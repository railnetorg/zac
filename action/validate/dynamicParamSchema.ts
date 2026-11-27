import { ZacError } from '../errors';
import { parseOperatorObject } from './operatorSchemas';
import { checkParamType } from './paramTypeSchema';
import { checkParamSanity } from './sanityChecks';
import { ABI_ENCODED_CHILD_KEYS, checkNoStrayKeys } from './strayKeys';

export interface AbiInput {
  name?: string;
  type: string;
  components?: AbiInput[];
}

interface AbiEncodedChild {
  name?: string;
  param_type?: string;
  operator?: string;
  value_type?: string;
  children?: AbiEncodedChild[];
  [k: string]: unknown;
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

  // Tuple param: `pass` (leave the whole tuple unscoped — the SDK applies the
  // same slot-skip to tuples as to scalars/arrays), `matches`, or any-type
  // composites. `tuple[]` lands here too via the `startsWith('tuple')` prefix;
  // `pass` is valid for it as well (the matches-recursion in the caller only
  // fires for an exact `tuple` type).
  if (abiType.startsWith('tuple')) {
    if (operator === 'pass') return;
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

  // Array param: array_* ops and any-type composites allowed; `pass` is
  // also accepted at the top level — it leaves the whole array slot
  // unscoped on-chain (the planner emits `undefined` for the position,
  // which the SDK's `calldataMatches` treats as "no scoping for this
  // slot" regardless of element type). Equivalent to omitting the param
  // entirely from `params[]`, except this satisfies the coverage check.
  if (abiType.endsWith('[]')) {
    if (operator === 'pass') return;
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

  // `param_type: abi_encoded` decodes a dynamic `bytes` slot into declared
  // children. It carries `children` instead of an `operator`, so it bypasses
  // the operator-family check and validates its children's ABI types instead.
  if ((param as { param_type?: string }).param_type === 'abi_encoded') {
    validateAbiEncodedParam(param, input);
    return;
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

/**
 * Derive the ABI type of one `abi_encoded` child slot. Mirrors the same rule in
 * `apply/toSdkTargets.ts` (kept in lockstep): `value_type` wins, else
 * `param_type: dynamic` / `abi_encoded` → `bytes`.
 */
function abiTypeOfChild(ch: AbiEncodedChild): string {
  if (ch.value_type) return ch.value_type;
  if (ch.param_type === 'dynamic') return 'bytes';
  if (ch.param_type === 'abi_encoded') return 'bytes';
  throw new ZacError({
    phase: 'validate',
    message: `abi_encoded child '${ch.name ?? '<unnamed>'}' needs a value_type, or param_type dynamic/abi_encoded, to define its ABI type`,
  });
}

/** `uintN`/`intN` sizes: 8 to 256 in steps of 8. */
const INT_SIZES = Array.from({ length: 32 }, (_, i) => String((i + 1) * 8)).join('|');

/** Elementary ABI types that fill exactly one 32-byte head word. */
const ONE_WORD_STATIC = new RegExp(
  `^(address|bool|u?int(${INT_SIZES})|bytes([1-9]|[12][0-9]|3[0-2]))$`,
);

/** Dynamic ABI types: one head word holding an offset to the tail. */
const DYNAMIC_TYPES = new Set(['bytes', 'string']);

/**
 * Check that an `abi_encoded` child's ABI type is one ZAC decodes and agrees
 * with its `param_type`. Each child's type fixes where every later child sits
 * in the payload, so a multi-word type (fixed array, tuple) or a type of the
 * wrong kind moves the word a sibling's condition reads, and a string that is
 * not an ABI type would only fail at `plan`. A `static` child takes one head
 * word; a `dynamic` child takes `bytes` or `string`.
 */
function checkChildAbiType(child: AbiEncodedChild, abiType: string, where: string): void {
  const pt = child.param_type;
  const ok =
    pt === 'static'
      ? ONE_WORD_STATIC.test(abiType)
      : pt === 'dynamic'
        ? DYNAMIC_TYPES.has(abiType)
        : pt === undefined && (ONE_WORD_STATIC.test(abiType) || DYNAMIC_TYPES.has(abiType));
  if (ok) return;
  throw new ZacError({
    phase: 'validate',
    message: `${where}: param_type ${pt ?? '<none>'} cannot hold ABI type '${abiType}' — a static child takes one head word (address, bool, uintN, intN, bytesN), a dynamic child takes bytes or string`,
  });
}

/** `obj` minus its `value_type` key; every other key is kept for the strict checks. */
function withoutValueType(obj: Record<string, unknown>): Record<string, unknown> {
  const { value_type: _vt, ...rest } = obj;
  void _vt;
  return rest;
}

/**
 * Validate a `param_type: abi_encoded` param. The param must sit on a dynamic
 * `bytes` input (the opaque encoded payload). Each ordered child declares its
 * own ABI type; the child operator is schema- and family-checked against it,
 * recursing for nested `abi_encoded` children.
 */
function validateAbiEncodedParam(
  param: { name: string; [k: string]: unknown },
  input: AbiInput,
): void {
  if (input.type !== 'bytes') {
    throw new ZacError({
      phase: 'validate',
      message: `'abi_encoded' param '${param.name}' must sit on a 'bytes' input, got '${input.type}'`,
    });
  }
  const children = (param as { children?: AbiEncodedChild[] }).children;
  if (!Array.isArray(children) || children.length === 0) {
    throw new ZacError({
      phase: 'validate',
      message: `'abi_encoded' param '${param.name}' requires a non-empty 'children' list`,
    });
  }
  for (const child of children) {
    const childWhere = `abi_encoded child '${child.name ?? '<unnamed>'}' of '${param.name}'`;
    // `param_type` decides this child's ABI type, so a misspelling here is
    // read as a missing declaration rather than as the typo it is.
    checkParamType(child.param_type, childWhere);
    const abiType = abiTypeOfChild(child);
    if (child.param_type === 'abi_encoded') {
      // A nested encoded blob: no operator object, so its key set is the
      // whole check, exactly as for an `abi_encoded` param at the top level.
      checkNoStrayKeys(child, ABI_ENCODED_CHILD_KEYS, childWhere);
      validateAbiEncodedParam({ ...child, name: child.name ?? '' }, { type: 'bytes' });
      continue;
    }
    checkChildAbiType(child, abiType, childWhere);
    // Schema-shape check (required fields per operator) on the operator object,
    // mirroring runValidate's top-level loop — and, because the operator
    // schemas are strict, the check that closes this child's vocabulary.
    // `children` is deliberately NOT stripped: it is read only on the
    // `abi_encoded` branch above, so on any other child it is a key that
    // states a nested layout ZAC will not decode, and the strict schema is
    // what says so.
    //
    // On a child, `value_type` types the decoded slot (`abiTypeOfChild`). An
    // operator that pins a value declares `value_type` in its own schema, so
    // there it stays. `pass` pins nothing: its `value_type` is only the slot
    // type, needed to decode the static slots around it, and comes off before
    // the operator checks, which forbid it on `pass`.
    const { name: _n, param_type: _pt, display_decode: _dd, ...childOp } = child;
    void _n;
    void _pt;
    void _dd;
    const opObj = child.operator === 'pass' ? withoutValueType(childOp) : childOp;
    parseOperatorObject(opObj, childWhere);
    checkParamSanity(
      opObj as { operator: string; value?: unknown; value_type?: string },
      child.name ?? '',
    );
    validateOperatorAgainstAbi(child as OperatorObj, abiType, child.name ?? '');
  }
}
