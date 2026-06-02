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

/**
 * A Plan is pure calldata — the role-state-update (and Safe-config) `calls`
 * the proposer must execute. It carries NO Safe transaction (`safeTxData` /
 * `safeTxHash`): those are built against the live Safe at SUBMIT time (see
 * `runBundledSubmit`), so `plan` needs neither an RPC nor a deployed Safe.
 *
 * `modifierAddress` is OPTIONAL — present in legacy per-file plans and in
 * per-safe-dir plans whose safe-dir declares at least one `.zac.yaml`,
 * absent in safe-only plans (a safe-dir with `safe.yaml` only and no role
 * configs). `serializePlan` conditionally spreads it so the JSON output
 * omits the key entirely when undefined; downstream `runBundledSubmit` /
 * `runPlanForSafeDir` do the same when constructing Plan instances.
 */
export const PlanSchema = z.object({
  calls: z.array(PlanCallSchema),
  callsCount: z.number().int().nonnegative(),
  chainId: z.number(),
  modifierAddress: z.string().optional(),
  safeAddress: z.string(),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanCall = z.infer<typeof PlanCallSchema>;
export type SafeTxData = z.infer<typeof SafeTxDataSchema>;

export function serializePlan(plan: Plan): string {
  // Conditional spread on `modifierAddress` — JSON omits the key when it
  // would have been `undefined` (safe-only plans).
  const withCount: Plan = {
    calls: plan.calls,
    callsCount: plan.calls.length,
    chainId: plan.chainId,
    ...(plan.modifierAddress !== undefined ? { modifierAddress: plan.modifierAddress } : {}),
    safeAddress: plan.safeAddress,
  };
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
