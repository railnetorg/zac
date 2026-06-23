import { parseAbiItem } from 'viem';
import { ZacError } from '../errors';
import type { Generated } from './parseGenerated';

interface ChildOp {
  operator?: string;
  param_type?: string;
  value?: unknown;
  values?: unknown[];
  value_type?: string;
  conditions?: ChildOp[];
  /** Decoded fields for a `param_type: abi_encoded` node (ordered). */
  children?: ParamYaml[];
}

interface ParamYaml extends ChildOp {
  name: string;
}

/** One `or` branch at the function root: a full positional param set. */
interface BranchYaml {
  operator?: string;
  params?: ParamYaml[];
}

/** A function rule — either a single positional `params` set or a root `or` of `branches`. */
interface FunctionYaml {
  signature: string;
  execution_options?: string;
  params?: ParamYaml[];
  operator?: string;
  branches?: BranchYaml[];
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
    abiEncodedMatches: (scoping: unknown, abiTypes: readonly string[]) => unknown;
    avatar: unknown;
  };
  processPermissions: (perms: unknown[]) => { targets: unknown[] };
}

/**
 * Derive the ABI type of one `abi_encoded` child slot. The bytes payload is
 * opaque (no signature components to read), so the YAML must declare the type:
 *   - `value_type` (e.g. uint256, address) wins when present;
 *   - `param_type: dynamic` → `bytes`;
 *   - `param_type: abi_encoded` → `bytes` (a nested encoded blob).
 */
function abiTypeOfChild(ch: ParamYaml): string {
  if (ch.value_type) return ch.value_type;
  if (ch.param_type === 'dynamic') return 'bytes';
  if (ch.param_type === 'abi_encoded') return 'bytes';
  throw new ZacError({
    phase: 'apply',
    message: `abi_encoded child '${ch.name}' needs a value_type, or param_type dynamic/abi_encoded, to define its ABI type`,
  });
}

/**
 * Build an `abiEncodedMatches` scoping for a `param_type: abi_encoded` node:
 * decode the bytes against `children`'s declared ABI types and match each slot.
 */
function buildAbiEncoded(op: ChildOp, c: SdkBuilders['c']): unknown {
  const children = op.children ?? [];
  if (children.length === 0) {
    throw new ZacError({
      phase: 'apply',
      message: `'abi_encoded' requires ≥ 1 child`,
    });
  }
  const abiTypes = children.map(abiTypeOfChild);
  const scopings = children.map((ch, i) => buildScoping(ch, { type: abiTypes[i]! }, c));
  return c.abiEncodedMatches(scopings, abiTypes);
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
  // `abi_encoded` is a param-type, not an operator: decode the bytes slot and
  // match its declared children. Checked before the operator switch since the
  // node carries no `operator`.
  if (op.param_type === 'abi_encoded') {
    return buildAbiEncoded(op, c);
  }
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
 * Mirror of validate's per-branch coverage check (`runValidate`'s
 * `checkParamCoverage`) on the apply path. Each `or` branch is an access-control
 * boundary: a branch that omits a parameter leaves that calldata slot
 * unconstrained — `buildPositionalScoping` maps a missing param to `undefined`
 * (no scoping), silently widening the whole `or` to allow any value there.
 * `generate` already rejects this via `validateRenderedTemplate`, but
 * `apply`/`plan` consume the generated YAML through `parseGenerated` with no
 * re-validation, so a hand-edited or out-of-band file could otherwise apply the
 * widened permission with no error. Throw instead. (Only enforced for `or`
 * branches; the single-`params` path intentionally treats a missing param as
 * `pass` and collapses an all-pass set to "unconstrained".)
 */
function assertBranchCoverage(
  params: ParamYaml[] | undefined,
  signature: string,
  branchIdx: number,
): void {
  const item = parseAbiItem(signature) as unknown as { inputs: AbiInput[] };
  const inputs = item.inputs ?? [];
  const names = new Set((params ?? []).map((p) => p.name));
  for (const inp of inputs) {
    const name = inp.name ?? '';
    if (!names.has(name)) {
      throw new ZacError({
        phase: 'apply',
        message: `'or' branch ${branchIdx} does not constrain parameter '${name}' of '${signature}'; every branch must address each parameter (an unconstrained slot silently widens the whole 'or')`,
      });
    }
  }
}

/**
 * Build the root condition for one function rule, or `null` when the function
 * is unconstrained (no params / all-pass). Two forms:
 *   - positional `params` → a single `calldataMatches`;
 *   - root `or` of `branches` (each a full positional param set) → an `or` of
 *     `calldataMatches`, one per branch. This lets a constraint on one
 *     parameter be correlated with constraints on others (e.g. a per-token-pair
 *     slippage cap), which a single flat scoping cannot express. A single branch
 *     collapses to a plain `calldataMatches` (an `or` of one is just that one),
 *     so template-driven branch lists work for a single (from, to) pair too.
 */
function buildFunctionCondition(fn: FunctionYaml, c: SdkBuilders['c']): unknown | null {
  if (fn.operator === 'or' || fn.branches !== undefined) {
    if (fn.operator !== undefined && fn.operator !== 'or') {
      throw new ZacError({
        phase: 'apply',
        message: `function-level operator '${fn.operator}' unsupported (only 'or' with branches)`,
      });
    }
    const branches = fn.branches ?? [];
    if (branches.length === 0) {
      throw new ZacError({
        phase: 'apply',
        message: `function-level 'or' requires ≥ 1 branch, got 0`,
      });
    }
    const conditions = branches.map((b, i) => {
      if (b.operator !== undefined && b.operator !== 'matches') {
        throw new ZacError({
          phase: 'apply',
          message: `'or' branch ${i} operator must be 'matches' (got '${b.operator}')`,
        });
      }
      assertBranchCoverage(b.params, fn.signature, i);
      const sc = buildPositionalScoping(b.params, fn.signature, c);
      if (sc === null) {
        throw new ZacError({
          phase: 'apply',
          message: `'or' branch ${i} has no constraints (all-pass); each branch must constrain ≥ 1 parameter`,
        });
      }
      return c.calldataMatches(sc.scoping, sc.abiTypes);
    });
    // An `or` of one branch is just that branch.
    return conditions.length === 1 ? conditions[0] : c.or(...conditions);
  }

  const sc = buildPositionalScoping(fn.params, fn.signature, c);
  return sc === null ? null : c.calldataMatches(sc.scoping, sc.abiTypes);
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
      const condition = buildFunctionCondition(fn as unknown as FunctionYaml, sdk.c);
      const perm: Record<string, unknown> = {
        targetAddress: target.address as `0x${string}`,
        signature: fn.signature,
        ...executionFlags((fn as { execution_options?: string }).execution_options),
      };
      if (condition !== null) {
        perm['condition'] = condition;
      }
      permissions.push(perm);
    }
  }
  const { targets } = sdk.processPermissions(permissions);
  return targets;
}
