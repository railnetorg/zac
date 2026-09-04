import { z } from 'zod';
import { ZacError } from '../errors';

const HexRegex = /^0x[0-9a-fA-F]+$/;

const Pass = z
  .object({
    operator: z.literal('pass'),
  })
  .strict();

const EqualTo = z
  .object({
    operator: z.literal('equal_to'),
    value: z.union([z.string(), z.number(), z.boolean()]),
    value_type: z.string().min(1),
  })
  .strict();

const EqualToAvatar = z
  .object({
    operator: z.literal('equal_to_avatar'),
  })
  .strict();

const GreaterThan = z
  .object({
    operator: z.literal('greater_than'),
    value: z.union([z.string(), z.number()]),
    value_type: z.string().min(1),
  })
  .strict();

const LessThan = z
  .object({
    operator: z.literal('less_than'),
    value: z.union([z.string(), z.number()]),
    value_type: z.string().min(1),
  })
  .strict();

const SignedIntGreaterThan = z
  .object({
    operator: z.literal('signed_int_greater_than'),
    value: z.union([z.string(), z.number()]),
    value_type: z.string().min(1),
  })
  .strict();

const SignedIntLessThan = z
  .object({
    operator: z.literal('signed_int_less_than'),
    value: z.union([z.string(), z.number()]),
    value_type: z.string().min(1),
  })
  .strict();

const OneOf = z
  .object({
    operator: z.literal('oneOf'),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
    value_type: z.string().min(1),
  })
  .strict();

const Bitmask = z
  .object({
    operator: z.literal('bitmask'),
    shift: z.number().int().nonnegative(),
    mask: z.string().regex(HexRegex),
    value: z.string().regex(HexRegex),
  })
  .strict();

// Recursive composite shapes use z.lazy. The runtime schema is what matters;
// the static type is conservative so the recursive reference compiles.
type Op =
  | z.infer<typeof Pass>
  | z.infer<typeof EqualTo>
  | z.infer<typeof EqualToAvatar>
  | z.infer<typeof GreaterThan>
  | z.infer<typeof LessThan>
  | z.infer<typeof SignedIntGreaterThan>
  | z.infer<typeof SignedIntLessThan>
  | z.infer<typeof OneOf>
  | z.infer<typeof Bitmask>
  | { operator: 'or' | 'and' | 'nor' | 'array_subset' | 'matches'; conditions: Op[] }
  | { operator: 'array_some' | 'array_every'; condition: Op };

export const OperatorSchema: z.ZodType<Op> = z.lazy(() =>
  z.discriminatedUnion('operator', [
    Pass,
    EqualTo,
    EqualToAvatar,
    GreaterThan,
    LessThan,
    SignedIntGreaterThan,
    SignedIntLessThan,
    OneOf,
    Bitmask,
    z
      .object({
        operator: z.literal('or'),
        conditions: z.array(OperatorSchema).min(1),
      })
      .strict(),
    z
      .object({
        operator: z.literal('and'),
        conditions: z.array(OperatorSchema).min(1),
      })
      .strict(),
    z
      .object({
        operator: z.literal('nor'),
        conditions: z.array(OperatorSchema).min(1),
      })
      .strict(),
    z
      .object({
        operator: z.literal('array_subset'),
        conditions: z.array(OperatorSchema).min(1),
      })
      .strict(),
    z
      .object({
        operator: z.literal('matches'),
        conditions: z.array(OperatorSchema).min(1),
      })
      .strict(),
    z
      .object({
        operator: z.literal('array_some'),
        condition: OperatorSchema,
      })
      .strict(),
    z
      .object({
        operator: z.literal('array_every'),
        condition: OperatorSchema,
      })
      .strict(),
  ]),
);

export type OperatorObject = Op;

/**
 * Parse an operator object, reporting a failure as a validate-phase
 * `ZacError` rather than letting a raw `ZodError` reach the CLI.
 *
 * Every schema above is `.strict()`, which makes this the check that rejects
 * a stray key on an ordinary param: the caller strips the param-level keys
 * off the param object and hands the remainder here, so anything left that
 * the operator does not declare arrives as an unrecognized key. That is the
 * error an author is most likely to see from this function, and a raw
 * `ZodError` dump names neither the param nor the file — hence `where`, which
 * should locate the param in the rendered template.
 */
export function parseOperatorObject(opObj: unknown, where: string): void {
  const result = OperatorSchema.safeParse(opObj);
  if (result.success) return;
  const first = result.error.issues[0]!;
  const path = first.path.length > 0 ? ` (${first.path.join('.')})` : '';

  // Phrase a stray key the way `strayKeys.ts` phrases one, and name the
  // operator it is not part of — the allowed set is per-operator here, so
  // "not declared by 'equal_to'" is the actionable half.
  if (first.code === 'unrecognized_keys') {
    const operator = (opObj as { operator?: unknown }).operator;
    const declaredBy =
      typeof operator === 'string'
        ? `not declared by operator '${operator}'`
        : 'not part of any operator';
    throw new ZacError({
      phase: 'validate',
      message:
        `unknown ${first.keys.length > 1 ? 'keys' : 'key'} ` +
        `${first.keys.map((k) => `'${k}'`).join(', ')} at ${where}${path} — ${declaredBy}`,
    });
  }

  throw new ZacError({
    phase: 'validate',
    message: `${where}${path}: ${first.message}`,
  });
}
