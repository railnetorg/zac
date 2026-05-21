import { parseAbiItem } from 'viem';
import { ZacError } from '../errors';

export interface ParsedFn {
  type: 'function';
  name: string;
  inputs: Array<{ name?: string; type: string; components?: unknown[] }>;
}

/**
 * Wrap viem's `parseAbiItem`, enforcing:
 *  - the parsed item is a function (not event/error/etc.)
 *  - every input has a non-empty `name` (§9.11)
 * Throws `ZacError({ phase: 'validate' })` on any failure.
 */
export function parseSignature(signature: string): ParsedFn {
  let item: unknown;
  try {
    item = parseAbiItem(signature);
  } catch (e) {
    throw new ZacError({
      phase: 'validate',
      message: `signature parse failed for '${signature}': ${(e as Error).message}`,
    });
  }
  const fn = item as ParsedFn;
  if (fn.type !== 'function') {
    throw new ZacError({
      phase: 'validate',
      message: `signature must be a function: '${signature}'`,
    });
  }
  const inputs = fn.inputs ?? [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    if (!input.name) {
      throw new ZacError({
        phase: 'validate',
        message: `signature '${signature}' has unnamed parameter at index ${i}; named parameters required (§9.11)`,
      });
    }
  }
  return fn;
}
