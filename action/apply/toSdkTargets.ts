import { parseAbiItem } from 'viem';
import { ZacError } from '../errors';
import type { Generated } from './parseGenerated';

interface ChildOp {
  operator: string;
  value?: unknown;
  values?: unknown[];
  value_type?: string;
  conditions?: ChildOp[];
}

interface ParamYaml extends ChildOp {
  name: string;
}

/**
 * Map a YAML `execution_options` string to the SDK FunctionPermission's
 * `send` / `delegatecall` flags. Omitted / "none" leaves both unset (the
 * SDK defaults to ExecutionOptions.None).
 */
function executionFlags(opt: string | undefined): { send?: boolean; delegatecall?: boolean } {
  switch (opt) {
    case undefined:
    case 'none':
      return {};
    case 'send':
      return { send: true };
    case 'delegatecall':
      return { delegatecall: true };
    case 'both':
      return { send: true, delegatecall: true };
    default:
      throw new ZacError({
        phase: 'apply',
        message: `unknown execution_options '${opt}' (expected none | send | delegatecall | both)`,
      });
  }
}

interface AbiInput {
  name?: string;
  type: string;
  components?: AbiInput[];
}

interface SdkBuilders {
  c: {
    eq: (v: unknown) => unknown;
    gt: (v: unknown) => unknown;
    lt: (v: unknown) => unknown;
    or: (...args: unknown[]) => unknown;
    matches: (scoping: unknown[]) => unknown;
    pass: unknown;
    calldataMatches: (scoping: unknown, abiTypes: readonly string[]) => unknown;
    avatar: unknown;
  };
  processPermissions: (perms: unknown[]) => { targets: unknown[] };
}

/**
 * Translate one operator YAML node into a zodiac-roles-sdk scoping value.
 * Always returns a concrete scoping (no `undefined`) — top-level all-pass
 * collapsing is `buildPositionalScoping`'s responsibility.
 *
 * `abiInput` describes the parent param. For `or`, all branches share the
 * same ABI type. For `matches` on a tuple, each child of `op.conditions`
 * is paired with the corresponding tuple component.
 */
function buildScoping(op: ChildOp, abiInput: AbiInput, c: SdkBuilders['c']): unknown {
  switch (op.operator) {
    case 'pass':
      return c.pass;
    case 'equal_to':
      return c.eq(op.value);
    case 'equal_to_avatar':
      return c.avatar;
    case 'oneOf':
      return c.or(...(op.values ?? []).map((v) => c.eq(v)));
    case 'greater_than':
    case 'signed_int_greater_than':
      return c.gt(op.value);
    case 'less_than':
    case 'signed_int_less_than':
      return c.lt(op.value);
    case 'or': {
      const conditions = op.conditions ?? [];
      if (conditions.length < 2) {
        throw new ZacError({
          phase: 'apply',
          message: `'or' requires ≥ 2 conditions, got ${conditions.length}`,
        });
      }
      const children = conditions.map((ch) => buildScoping(ch, abiInput, c));
      return c.or(...children);
    }
    case 'matches': {
      const components = abiInput.components;
      if (!components) {
        throw new ZacError({
          phase: 'apply',
          message: `'matches' used on non-tuple ABI type '${abiInput.type}'`,
        });
      }
      const conditions = op.conditions ?? [];
      if (conditions.length !== components.length) {
        throw new ZacError({
          phase: 'apply',
          message: `'matches' arity mismatch: ${conditions.length} conditions vs ${components.length} components`,
        });
      }
      const childScopings = conditions.map((ch, i) => buildScoping(ch, components[i]!, c));
      return c.matches(childScopings);
    }
    default:
      throw new ZacError({
        phase: 'apply',
        message: `unsupported operator '${op.operator}' (apply currently supports leaves + or + matches; and/nor/bitmask/array_* pending)`,
      });
  }
}

/**
 * Reconstruct the canonical ABI type string for an input. Tuples come back
 * from viem as `type: 'tuple'` (or `'tuple[]'`, etc.) plus a `components`
 * array — but `ethers.ParamType.from`, which the SDK calls on every abiType
 * we hand it, rejects the bare string `"tuple"`. We expand to
 * `(comp1,comp2,...)` (preserving any `[]` array suffix) so the SDK can
 * parse the full descriptor.
 */
function canonicalAbiType(input: AbiInput): string {
  if (input.type.startsWith('tuple') && Array.isArray(input.components)) {
    const inner = input.components.map(canonicalAbiType).join(',');
    const arraySuffix = input.type.slice('tuple'.length); // '', '[]', '[3]', etc.
    return `(${inner})${arraySuffix}`;
  }
  return input.type;
}

function buildPositionalScoping(
  params: ParamYaml[] | undefined,
  signature: string,
  c: SdkBuilders['c'],
): { scoping: unknown[]; abiTypes: string[] } | null {
  const item = parseAbiItem(signature) as unknown as { inputs: AbiInput[] };
  const inputs = item.inputs ?? [];
  if (inputs.length === 0) return null;
  const abiTypes = inputs.map(canonicalAbiType);
  if (!params || params.length === 0) return null;
  const byName = new Map(params.map((p) => [p.name, p]));
  const out: unknown[] = [];
  let allPass = true;
  for (const inp of inputs) {
    const p = byName.get(inp.name ?? '');
    if (!p) {
      out.push(undefined);
      continue;
    }
    if (p.operator === 'pass') {
      // Top-level `pass` stays as the calldataMatches "skip this slot" sentinel.
      // (Inside composites buildScoping returns c.pass instead.) An all-pass
      // params block is semantically equivalent to no scoping at all, so we
      // optimize to a null return below.
      out.push(undefined);
      continue;
    }
    allPass = false;
    out.push(buildScoping(p, inp, c));
  }
  if (allPass) return null;
  return { scoping: out, abiTypes };
}

/**
 * Translate one role's YAML targets[] into the SDK's on-chain Target[] shape
 * that planApplyRole consumes. Builds flat Permission[] then runs
 * processPermissions to flatten/coerce.
 */
export function toSdkTargets(generated: Generated, roleKey: string, sdk: SdkBuilders): unknown[] {
  const role = generated.roles[roleKey];
  if (!role) return [];
  const permissions: Array<Record<string, unknown>> = [];
  for (const target of role.targets) {
    for (const fn of target.functions) {
      const scopingResult = buildPositionalScoping(
        fn.params as ParamYaml[] | undefined,
        fn.signature,
        sdk.c,
      );
      const perm: Record<string, unknown> = {
        targetAddress: target.address as `0x${string}`,
        signature: fn.signature,
        ...executionFlags((fn as { execution_options?: string }).execution_options),
      };
      if (scopingResult !== null) {
        perm['condition'] = sdk.c.calldataMatches(scopingResult.scoping, scopingResult.abiTypes);
      }
      permissions.push(perm);
    }
  }
  const { targets } = sdk.processPermissions(permissions);
  return targets;
}
