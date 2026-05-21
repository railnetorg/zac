import { z } from 'zod';

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
