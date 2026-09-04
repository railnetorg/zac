import { ZacError } from '../errors';

/**
 * The key vocabulary of the rendered-template DSL, level by level, and the
 * check that rejects anything outside it.
 *
 * A key ZAC does not read is not a harmless extra. The DSL exists to state
 * what a role may do, so an author who writes a key ZAC ignores believes a
 * rule is in force that is not — and the mistake ships, because a policy that
 * is wider or narrower than intended is still a valid policy: it renders,
 * validates, plans and applies. The failures are ordinary typos. A singular
 * `execution_option: "send"` produces a role that cannot attach ETH and reads
 * exactly like one that can.
 *
 * Listed here are the levels that have no schema of their own. An ordinary
 * param's stray keys are already rejected by the strict operator schemas in
 * `operatorSchemas.ts`, which see the param object once the param-level keys
 * are stripped off it. The exception is `param_type: abi_encoded`, which
 * carries `children` in place of an operator and so has no operator object to
 * be checked against.
 */

/** A `roles[]` entry: one target address and the functions scoped on it. */
export const ROLE_KEYS = ['address', 'functions'] as const;

/**
 * A `functions[]` entry. The two forms — a positional `params` set, or a root
 * `or` given as `operator: or` plus `branches` — share one vocabulary rather
 * than splitting it, because which form applies is decided from the keys that
 * are present, and that decision is reported by `validateRenderedTemplate`.
 */
export const FUNCTION_KEYS = [
  'signature',
  'execution_options',
  'params',
  'operator',
  'branches',
] as const;

/** A `branches[]` entry under a root `or`: one full positional param set. */
export const BRANCH_KEYS = ['operator', 'params'] as const;

/**
 * A `param_type: abi_encoded` param — the one param shape with no operator
 * object. `display_decode` is absent on purpose: it decodes a pinned `bytes`
 * value for `zac plan`, and this param pins no value, only children.
 */
export const ABI_ENCODED_PARAM_KEYS = ['name', 'param_type', 'children'] as const;

/**
 * A `param_type: abi_encoded` node nested in another one's `children`. Same
 * shape plus `value_type`, which is what gives the child slot its ABI type
 * (`abiTypeOfChild`, dynamicParamSchema.ts) instead of defaulting to `bytes`.
 */
export const ABI_ENCODED_CHILD_KEYS = [...ABI_ENCODED_PARAM_KEYS, 'value_type'] as const;

/**
 * Reject every key on `value` outside `allowed`, and reject a `value` that is
 * not a mapping at all. `where` locates the node for the reader and should be
 * specific enough to find it in a rendered template — a path, a signature, a
 * param name.
 */
export function checkNoStrayKeys(value: unknown, allowed: readonly string[], where: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ZacError({
      phase: 'validate',
      message: `${where} must be a mapping, got ${describeShape(value)}`,
    });
  }

  const stray = Object.keys(value).filter((k) => !allowed.includes(k));
  if (stray.length === 0) return;

  throw new ZacError({
    phase: 'validate',
    message:
      `unknown ${stray.length > 1 ? 'keys' : 'key'} ${stray.map((k) => `'${k}'`).join(', ')} ` +
      `at ${where} — allowed: ${allowed.join(', ')}`,
  });
}

/** How a non-mapping reads in an error message. */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}
