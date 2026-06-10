import { decodeAbiParameters } from 'viem';
import type { AbiInput, FunctionParams } from './buildFunctionParamMap';

/**
 * Generic tree node for the foundry-style printer. `label` is the text
 * after the connector glyph; `children` are nested branches. The printer
 * computes `├─ ` / `└─ ` connectors and `│   ` / `    ` continuation
 * prefixes from position alone, so labels never carry tree characters.
 */
export interface TreeNode {
  label: string;
  children?: TreeNode[];
}

interface ParamObj {
  name: string;
  operator?: string;
  param_type?: string;
  children?: ParamObj[];
  [k: string]: unknown;
}

/**
 * Build the param-subtree for one `scopeFunction` call. Each top-level
 * positional input becomes a node `<type> <name>  <constraint>`; nested
 * tuple components and `or` branches recurse into children. Returns an
 * empty array when there are no inputs (i.e. `function f()` — nothing to
 * scope), so the caller renders the call as a leaf.
 *
 * Column alignment is per-level: each call sets its own type/name column
 * widths, recomputed inside every tuple expansion so a 1-arg deposit
 * doesn't pay for a 5-arg tuple's columns.
 */
export function renderParamTree(
  fn: FunctionParams,
  addressLabelMap: Record<string, string> | undefined,
): TreeNode[] {
  if (fn.inputs.length === 0) return [];
  // Function-root `or`: render each branch's positional param set under
  // `option N`, mirroring the on-chain `or(calldataMatches, …)` shape.
  if (fn.branches && fn.branches.length > 0) {
    return fn.branches.map((branch, i) => ({
      label: `option ${i + 1}`,
      children: renderInputs(
        fn.inputs,
        new Map((branch.params ?? []).map((p) => [p.name, p as unknown as ParamObj])),
        addressLabelMap,
      ),
    }));
  }
  const byName = new Map(fn.params.map((p) => [p.name, p as unknown as ParamObj]));
  return renderInputs(fn.inputs, byName, addressLabelMap);
}

function renderInputs(
  inputs: AbiInput[],
  byName: Map<string, ParamObj>,
  addressLabelMap: Record<string, string> | undefined,
): TreeNode[] {
  const typeStrs = inputs.map((i) => abiTypeShort(i));
  const nameStrs = inputs.map((i) => i.name ?? '');
  const typeWidth = Math.max(...typeStrs.map((s) => s.length));
  const nameWidth = Math.max(...nameStrs.map((s) => s.length));

  const out: TreeNode[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const param = input.name !== undefined ? byName.get(input.name) : undefined;
    out.push(
      renderOneInput(
        input,
        param,
        addressLabelMap,
        typeStrs[i]!,
        nameStrs[i]!,
        typeWidth,
        nameWidth,
      ),
    );
  }
  return out;
}

/**
 * Render one positional input as a tree node. Composites (`matches`,
 * `or` of composites) become nodes with children; leaves (`pass`,
 * `equal_to`, leaf-only `or`, etc.) are flat labels.
 */
function renderOneInput(
  input: AbiInput,
  param: ParamObj | undefined,
  addressLabelMap: Record<string, string> | undefined,
  typeStr: string,
  nameStr: string,
  typeWidth: number,
  nameWidth: number,
): TreeNode {
  const head = headPrefix(typeStr, nameStr, typeWidth, nameWidth);
  if (param === undefined) {
    // Source didn't mention this slot — `toSdkTargets` reads it as `pass`.
    // Surface it explicitly so the reader sees the position got nothing.
    return { label: `${head}*` };
  }
  return renderCondition(param, input, addressLabelMap, head);
}

/**
 * Render any condition (top-level or nested). The `head` argument is the
 * already-formatted `<type> <name>  ` column prefix to lay the constraint
 * against. Composites set their own head for child nodes.
 */
function renderCondition(
  cond: ParamObj,
  input: AbiInput,
  addressLabelMap: Record<string, string> | undefined,
  head: string,
): TreeNode {
  // `abi_encoded` decodes the bytes slot into declared children — render the
  // decoded structure rather than the opaque `bytes` leaf.
  if (cond.param_type === 'abi_encoded') {
    return {
      label: `${head}= abiEncoded`,
      children: renderAbiEncoded(cond.children ?? [], addressLabelMap),
    };
  }
  switch (cond.operator) {
    case 'pass':
      return { label: `${head}*` };
    case 'equal_to': {
      // A `display_decode` hint means this pinned `bytes` value is itself an
      // abi.encode(...) blob — decode it for the reader instead of dumping the
      // opaque hex (e.g. a Milkman price-checker innerData = (feeds, reverses)).
      const decoded = renderDisplayDecode(cond, addressLabelMap);
      if (decoded !== null) return { label: `${head}= abiEncoded`, children: decoded };
      return {
        label: `${head}= ${formatValue(cond['value'], (cond['value_type'] as string) ?? input.type, addressLabelMap)}`,
      };
    }
    case 'equal_to_avatar':
      return { label: `${head}= <avatar>` };
    case 'greater_than':
    case 'signed_int_greater_than':
      return {
        label: `${head}> ${formatValue(cond['value'], (cond['value_type'] as string) ?? input.type, addressLabelMap)}`,
      };
    case 'less_than':
    case 'signed_int_less_than':
      return {
        label: `${head}< ${formatValue(cond['value'], (cond['value_type'] as string) ?? input.type, addressLabelMap)}`,
      };
    case 'bitmask':
      return {
        label: `${head}bitmask(shift=${String(cond['shift'])}, mask=${String(cond['mask'])}, value=${String(cond['value'])})`,
      };
    case 'oneOf': {
      const values = (cond['values'] as unknown[]) ?? [];
      const valueType = (cond['value_type'] as string) ?? input.type;
      const formatted = values.map((v) => formatValue(v, valueType, addressLabelMap));
      return { label: `${head}in (${formatted.join(', ')})` };
    }
    case 'or':
    case 'and':
    case 'nor':
    case 'array_subset': {
      const conds = (cond['conditions'] as ParamObj[]) ?? [];
      // Inline form for `or` of pure leaves with values — degenerates to
      // `in (…)`. Saves a tree level on the common token-allow-list pattern.
      if (cond.operator === 'or' && conds.every((c) => isLeafEq(c))) {
        const valueType = (conds[0]?.['value_type'] as string) ?? input.type;
        const formatted = conds.map((c) => formatValue(c['value'], valueType, addressLabelMap));
        return { label: `${head}in (${formatted.join(', ')})` };
      }
      const headKeyword = compositeKeyword(cond.operator);
      // Composite of composites — expand each branch as `option N`.
      const children: TreeNode[] = conds.map((branch, i) => {
        const optHead = `option ${i + 1}`;
        if (branch.operator === 'matches' && input.components) {
          return {
            label: optHead,
            children: renderMatches(branch, input.components, addressLabelMap),
          };
        }
        // Non-matches branch — render the branch as a single leaf using a
        // synthetic head so it lines up under `option N` cleanly.
        return renderCondition(branch, input, addressLabelMap, `${optHead}  `);
      });
      return { label: `${head}= ${headKeyword}`, children };
    }
    case 'matches': {
      const components = input.components ?? [];
      return {
        label: `${head}= matches`,
        children: renderMatches(cond, components, addressLabelMap),
      };
    }
    case 'array_some':
    case 'array_every': {
      const inner = cond['condition'] as ParamObj | undefined;
      const keyword = cond.operator === 'array_some' ? 'some' : 'every';
      const elementInput = input.components?.[0] ?? { type: stripArraySuffix(input.type) };
      if (inner === undefined) return { label: `${head}= ${keyword}` };
      // Render the element constraint as a single child under the header.
      const elementHead = headPrefix(
        abiTypeShort(elementInput),
        '',
        abiTypeShort(elementInput).length,
        0,
      );
      return {
        label: `${head}= ${keyword}`,
        children: [renderCondition(inner, elementInput, addressLabelMap, elementHead)],
      };
    }
    default:
      return { label: `${head}${cond.operator}(…)` };
  }
}

/**
 * Render the children of a `matches` condition: pair each ordered child
 * condition with the tuple's corresponding ABI component. Recomputes
 * type/name widths so this level's columns are local.
 */
function renderMatches(
  cond: ParamObj,
  components: AbiInput[],
  addressLabelMap: Record<string, string> | undefined,
): TreeNode[] {
  const conditions = (cond['conditions'] as ParamObj[]) ?? [];
  const n = Math.min(conditions.length, components.length);
  const typeStrs = components.slice(0, n).map((c) => abiTypeShort(c));
  const nameStrs = components.slice(0, n).map((c) => c.name ?? '');
  const typeWidth = Math.max(...typeStrs.map((s) => s.length), 0);
  const nameWidth = Math.max(...nameStrs.map((s) => s.length), 0);
  const out: TreeNode[] = [];
  for (let i = 0; i < n; i++) {
    const head = headPrefix(typeStrs[i]!, nameStrs[i]!, typeWidth, nameWidth);
    out.push(renderCondition(conditions[i]!, components[i]!, addressLabelMap, head));
  }
  return out;
}

/**
 * Render the decoded children of an `abi_encoded` node. Each child's ABI type
 * is derived from its `value_type` (or `bytes` for dynamic / nested abi_encoded),
 * matching the translation + validation rule.
 */
function renderAbiEncoded(
  children: ParamObj[],
  addressLabelMap: Record<string, string> | undefined,
): TreeNode[] {
  const typeOf = (c: ParamObj): string => (c['value_type'] as string | undefined) ?? 'bytes';
  const typeStrs = children.map(typeOf);
  const nameStrs = children.map((c) => c.name ?? '');
  const typeWidth = Math.max(...typeStrs.map((s) => s.length), 0);
  const nameWidth = Math.max(...nameStrs.map((s) => s.length), 0);
  return children.map((child, i) => {
    const head = headPrefix(typeStrs[i]!, nameStrs[i]!, typeWidth, nameWidth);
    return renderCondition(child, { type: typeStrs[i]! }, addressLabelMap, head);
  });
}

interface DecodeField {
  name?: string;
  type: string;
}

/**
 * Render the decoded view of a pinned `bytes` value when the param carries a
 * `display_decode` hint — an ordered `[{ name, type }]` list describing the
 * ABI layout of the blob (e.g. `[{name: feeds, type: 'address[]'}, …]`). This
 * is display-only: the on-chain condition still pins the exact bytes via
 * `equal_to`; we just abi.decode the constant so the reader sees the structure
 * rather than a wall of hex. Returns `null` (caller falls back to the raw hex
 * leaf) when there's no hint or the value can't be decoded against it.
 */
function renderDisplayDecode(
  cond: ParamObj,
  addressLabelMap: Record<string, string> | undefined,
): TreeNode[] | null {
  const spec = cond['display_decode'];
  const value = cond['value'];
  if (!Array.isArray(spec) || spec.length === 0) return null;
  if (typeof value !== 'string' || !value.startsWith('0x')) return null;
  const fields = spec as DecodeField[];
  if (!fields.every((f) => typeof f?.type === 'string')) return null;

  let decoded: readonly unknown[];
  try {
    decoded = decodeAbiParameters(
      fields.map((f) => ({ type: f.type })),
      value as `0x${string}`,
    );
  } catch {
    return null; // malformed hint or value — fall back to the raw hex leaf.
  }

  const typeStrs = fields.map((f) => f.type);
  const nameStrs = fields.map((f) => f.name ?? '');
  const typeWidth = Math.max(...typeStrs.map((s) => s.length), 0);
  const nameWidth = Math.max(...nameStrs.map((s) => s.length), 0);
  return fields.map((_f, i) => {
    const head = headPrefix(typeStrs[i]!, nameStrs[i]!, typeWidth, nameWidth);
    return { label: `${head}= ${formatDecodedValue(decoded[i], typeStrs[i]!, addressLabelMap)}` };
  });
}

/**
 * Format a decoded ABI value for display. Arrays render as `[a, b, …]` with
 * each element formatted by its element type; scalars defer to `formatValue`
 * (so addresses still get the `0x….… (label)` treatment, bools read true/false).
 */
function formatDecodedValue(
  v: unknown,
  type: string,
  addressLabelMap: Record<string, string> | undefined,
): string {
  if (type.endsWith('[]') && Array.isArray(v)) {
    const elementType = stripArraySuffix(type);
    return `[${v.map((e) => formatDecodedValue(e, elementType, addressLabelMap)).join(', ')}]`;
  }
  return formatValue(v, type, addressLabelMap);
}

function isLeafEq(c: ParamObj): boolean {
  return c.operator === 'equal_to' && c['value'] !== undefined;
}

function compositeKeyword(op: string): string {
  switch (op) {
    case 'or':
      return 'oneOf';
    case 'and':
      return 'matches';
    case 'nor':
      return 'noneOf';
    case 'array_subset':
      return 'subset';
    default:
      return op;
  }
}

/**
 * `<type><pad> <name><pad>  ` — leaves three trailing spaces so the
 * constraint starts at a stable column. When the row has no name (anonymous
 * tuple slot or array element), the name column collapses entirely.
 */
function headPrefix(
  typeStr: string,
  nameStr: string,
  typeWidth: number,
  nameWidth: number,
): string {
  const t = typeStr.padEnd(typeWidth);
  if (nameWidth === 0) return `${t}  `;
  const n = nameStr.padEnd(nameWidth);
  return `${t} ${n}  `;
}

/**
 * Canonical short ABI type for display. Tuples render as `tuple` (without
 * expanding components — the children carry the real shape); arrays keep
 * their suffix.
 */
function abiTypeShort(input: AbiInput): string {
  if (input.type.startsWith('tuple')) return `tuple${input.type.slice('tuple'.length)}`;
  return input.type;
}

function stripArraySuffix(t: string): string {
  return t.replace(/\[\d*\]$/, '');
}

/**
 * Render a constraint value for display. Address-typed values consult the
 * shared label map and get the `0xABCD…1234 (label)` treatment; all other
 * value types are passed through `String(v)` — viem-emitted decimals
 * stay legible; bytes stay hex.
 */
function formatValue(
  v: unknown,
  valueType: string | undefined,
  addressLabelMap: Record<string, string> | undefined,
): string {
  if (
    typeof v === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(v) &&
    (valueType === undefined || valueType.startsWith('address'))
  ) {
    const short = `${v.slice(0, 6)}…${v.slice(-4)}`;
    const label = addressLabelMap?.[v.toLowerCase()];
    return label === undefined ? short : `${short} (${label})`;
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
