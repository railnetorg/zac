import { z } from 'zod';
import { isAddress } from 'viem';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { ZacError } from '../errors';

const Address = z.string().refine((s) => isAddress(s), {
  message: 'must be a valid Ethereum address',
});

// Param entries forward extra fields (value, value_type, values, children, ...)
// through to planApplyRole — passthrough so we don't have to re-encode the
// operator taxonomy validated by the Phase 6 schemas. `operator` is optional
// because a `param_type: abi_encoded` node carries `children` instead.
//
// This is the one place a stray key is not rejected, and it is a deliberate
// trade: closing it here would mean restating the operator vocabulary in a
// second schema that could drift from the first. `toSdkTargets` is what reads
// these fields, and it fails closed on anything it does not recognize.
const Param = z
  .object({
    name: z.string(),
    operator: z.string().optional(),
  })
  .passthrough();

// A function rule is either a positional `params` set or a root `or` of
// `branches`. The extra `operator` / `branches` keys pass through (passthrough);
// the operator taxonomy is enforced in the validate phase + `toSdkTargets`.
const FunctionRule = z
  .object({
    signature: z.string(),
    execution_options: z.string().optional(),
    params: z.array(Param).optional(),
  })
  .passthrough();

// The levels with a closed vocabulary are strict, unlike the two above. This
// file is the only gate on the generated artifact: `plan` and `apply` read it
// without re-running the validate phase, so a key nothing reads here is a key
// nothing reads at all before the calls go on chain. A stale artifact left by
// an older ZAC is the way one gets there — `zac generate` rejects a stray key
// at render time, so it never writes one.
const Target = z
  .object({
    address: Address,
    functions: z.array(FunctionRule),
  })
  .strict();

const RoleEntry = z
  .object({
    members: z.array(Address),
    targets: z.array(Target),
  })
  .strict();

export const GeneratedSchema = z
  .object({
    deployment: z
      .object({
        chain_id: z.number().int().positive(),
        safe_address: Address,
        roles_modifier_address: Address,
      })
      .strict(),
    roles: z.record(z.string(), RoleEntry),
  })
  .strict();

export type Generated = z.infer<typeof GeneratedSchema>;

export function parseGenerated(path: string): Generated {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ZacError({
      phase: 'load',
      message: `failed to read ${path}`,
      sourceLocation: { file: path },
    });
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new ZacError({
      phase: 'parse',
      message: `YAML parse failed in ${path}: ${doc.errors[0]!.message}`,
      sourceLocation: { file: path },
    });
  }
  const result = GeneratedSchema.safeParse(doc.toJSON());
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new ZacError({
      phase: 'validate',
      message: `${first.path.join('.')}: ${first.message}`,
      sourceLocation: { file: path },
    });
  }
  return result.data;
}
