import { isAddress, getAddress } from 'viem';
import { ZacError } from '../errors';

const NO_VALUE_OPERATORS = new Set(['pass', 'equal_to_avatar']);
const NO_VALUE_TYPE_OPERATORS = new Set(['pass', 'equal_to_avatar']);

interface ParamLike {
  operator: string;
  value?: unknown;
  value_type?: string;
}

/**
 * Per-param sanity rules (§9.9, the non-schema parts). Schema layer already
 * enforces required-field presence per operator; this layer enforces the
 * forbidden-field rules that the schema cannot express via the discriminated
 * union alone (since `.strict()` is enough but kept for defense in depth).
 */
export function checkParamSanity(p: ParamLike, paramName: string): void {
  if (NO_VALUE_OPERATORS.has(p.operator) && p.value !== undefined) {
    throw new ZacError({
      phase: 'validate',
      message: `operator '${p.operator}' on '${paramName}' must not have a 'value'`,
    });
  }
  if (NO_VALUE_TYPE_OPERATORS.has(p.operator) && p.value_type !== undefined) {
    throw new ZacError({
      phase: 'validate',
      message: `operator '${p.operator}' on '${paramName}' must not have a 'value_type'`,
    });
  }
}

/**
 * Bidirectional name coverage between `params[]` and the parsed signature
 * inputs: every signature input must be addressed by a `params[i]`, and every
 * `params[i].name` must correspond to a signature input.
 */
export function checkParamCoverage(paramNames: string[], inputNames: string[]): void {
  const ps = new Set(paramNames);
  const is = new Set(inputNames);
  for (const n of inputNames) {
    if (!ps.has(n)) {
      throw new ZacError({
        phase: 'validate',
        message: `param '${n}' from signature is not covered in params[]`,
      });
    }
  }
  for (const n of paramNames) {
    if (!is.has(n)) {
      throw new ZacError({
        phase: 'validate',
        message: `param '${n}' is not present in signature`,
      });
    }
  }
}

/**
 * Validate + checksum-normalize an address. Throws on bad checksum or invalid
 * format. `isAddress` (default mode) performs the checksum verification —
 * mixed-case-but-wrong-checksum addresses are rejected here, all-lowercase
 * inputs pass through and are normalized via `getAddress`.
 */
export function checksumAddress(addr: string, source: string): string {
  if (!isAddress(addr)) {
    throw new ZacError({
      phase: 'validate',
      message: `'${addr}' is not a valid address (at ${source})`,
    });
  }
  try {
    return getAddress(addr);
  } catch (e) {
    throw new ZacError({
      phase: 'validate',
      message: `'${addr}' has bad checksum (at ${source}): ${(e as Error).message}`,
    });
  }
}
