import { z } from 'zod';
import { ZacError } from '../errors';

/**
 * The `execution_options` taxonomy — the DSL's spelling of Roles V2's
 * `ExecutionOptions` enum (`None | Send | DelegateCall | Both`). Omitting
 * the key is equivalent to `none`.
 *
 * This is the field that decides whether a role may attach native ETH to a
 * call (`send`) or execute in the avatar's own storage context
 * (`delegatecall`), which makes it the one field in the DSL whose typos are
 * worth catching in the same phase as every other policy error rather than
 * at plan time. `executionFlags` in `apply/toSdkTargets.ts` still rejects
 * anything outside this set — it is the boundary that maps to the SDK, and
 * it stays fail-closed independently of this schema.
 */
export const EXECUTION_OPTIONS = ['none', 'send', 'delegatecall', 'both'] as const;

export const ExecutionOptionsSchema = z.enum(EXECUTION_OPTIONS);

export type ExecutionOptionsValue = z.infer<typeof ExecutionOptionsSchema>;

/** The allowed set, rendered for error messages: `none | send | ...`. */
const ALLOWED = EXECUTION_OPTIONS.join(' | ');

/**
 * Validate one function's `execution_options`. Absent is valid (it means
 * `none`); anything present must be one of `EXECUTION_OPTIONS`. The error
 * names the field, the value it got, the allowed set, and the signature it
 * sits on, so an author does not have to guess which of a template's
 * functions is wrong.
 */
export function checkExecutionOptions(value: unknown, signature: string): void {
  if (value === undefined) return;
  if (ExecutionOptionsSchema.safeParse(value).success) return;
  throw new ZacError({
    phase: 'validate',
    message: `execution_options ${JSON.stringify(value)} on '${signature}' is not one of ${ALLOWED}`,
  });
}
