import { z } from 'zod';
import { ZacError } from '../errors';

/**
 * The `param_type` taxonomy — the DSL's declaration of how a param's slot is
 * laid out in calldata. The key is optional; most params declare none.
 *
 * `static` and `tuple` are documentation: the operator's ABI family is checked
 * against the parsed signature, which is the ground truth for both. The other
 * two are load-bearing. `abi_encoded` selects the branch that decodes a
 * `bytes` slot into declared `children`, and `dynamic` is what gives a child
 * of that branch the ABI type `bytes` when it declares no `value_type`
 * (`abiTypeOfChild`, dynamicParamSchema.ts).
 *
 * So a misspelling either means nothing at all or silently changes the shape
 * ZAC reads — `param_type: "dynammic"` on a child leaves the slot with no
 * derivable ABI type, and reports that as a missing `value_type` rather than
 * as the typo it is. Checking the value is what turns both into one error that
 * names the field.
 */
export const PARAM_TYPES = ['static', 'dynamic', 'tuple', 'abi_encoded'] as const;

export const ParamTypeSchema = z.enum(PARAM_TYPES);

export type ParamTypeValue = z.infer<typeof ParamTypeSchema>;

/** The allowed set, rendered for error messages: `static | dynamic | ...`. */
const ALLOWED = PARAM_TYPES.join(' | ');

/**
 * Validate one param's `param_type`. Absent is valid; anything present must
 * be one of `PARAM_TYPES`. `where` locates the param for the reader.
 */
export function checkParamType(value: unknown, where: string): void {
  if (value === undefined) return;
  if (ParamTypeSchema.safeParse(value).success) return;
  throw new ZacError({
    phase: 'validate',
    message: `param_type ${JSON.stringify(value)} at ${where} is not one of ${ALLOWED}`,
  });
}
