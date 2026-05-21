import { z } from 'zod';

export const PlanCallSchema = z.object({
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  value: z.string().regex(/^[0-9]+$/),
});

export const SafeTxDataSchema = z.object({
  baseGas: z.string(),
  data: z.string(),
  gasPrice: z.string(),
  gasToken: z.string(),
  nonce: z.union([z.number(), z.string()]),
  operation: z.number(),
  refundReceiver: z.string(),
  safeTxGas: z.string(),
  to: z.string(),
  value: z.string(),
});

export const PlanSchema = z.object({
  calls: z.array(PlanCallSchema),
  callsCount: z.number().int().nonnegative(),
  chainId: z.number(),
  modifierAddress: z.string(),
  safeAddress: z.string(),
  safeTxData: SafeTxDataSchema,
  safeTxHash: z.string(),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanCall = z.infer<typeof PlanCallSchema>;
export type SafeTxData = z.infer<typeof SafeTxDataSchema>;

export function serializePlan(plan: Plan): string {
  const withCount: Plan = { ...plan, callsCount: plan.calls.length };
  return JSON.stringify(sortDeep(withCount), null, 2);
}

export function parsePlan(json: string): Plan {
  return PlanSchema.parse(JSON.parse(json));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
