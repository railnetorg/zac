import { decodeCall, type DecodeSdk, type DecodedCall } from './decodeCall';
import type { Plan } from './planSchema';
import type { FunctionParams } from './buildFunctionParamMap';
import { renderParamTree, type TreeNode } from './renderParamTree';

export interface PrintPlanDiffOpts {
  /** Human-friendly path for the header line — caller should pre-apply `displayPath`. */
  planPath: string;
  /**
   * Plain-string Safe address (matches `Plan.safeAddress: z.string()`).
   * Threaded into `decodeCall` to gate the Safe-ABI dispatch path —
   * without it, the `enableModule` / `disableModule` selectors (shared
   * with Roles modifier ABI) would misclassify between sections.
   */
  safeAddress: string;
  /**
   * Role keys declared in the safe-dir's sources (decoded string form).
   * Present ONLY in per-safe-dir mode. When set, revokes targeting role
   * keys NOT in this set are annotated inline `⚠ not declared in any
   * source` next to the role-key tree node. When undefined (legacy
   * per-file mode), no annotation is emitted.
   */
  declaredRoleKeys?: Set<string>;
  /** Defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /**
   * SDK + decoder injection point. The CLI lazily imports
   * `zodiac-roles-sdk` and passes the runtime `{ decodeKey, rolesAbi }`;
   * unit tests pass stubs.
   */
  sdk: DecodeSdk;
  /**
   * Optional selector → function-name map, typically built from the
   * sources being planned (via `buildSelectorMap`). Looked up BEFORE the
   * built-in ERC20 catalog, so user-defined function signatures decode
   * to their human name in the call header. Unknown selectors still fall
   * through to raw hex.
   */
  selectorMap?: Record<string, string>;
  /**
   * Optional lowercase-address → dotted-path label map (built from the
   * alias registry via `buildAddressLabelMap`). When set, a known target
   * address renders as `0xA0b8…eB48 (tokens.USDC)`; unknown addresses
   * keep the bare shortened form. Also consulted for address-typed
   * param values inside the constraint subtree.
   */
  addressLabelMap?: Record<string, string>;
  /**
   * Optional `<roleKey>:<target_lower>:<selector_lower>` → source-side
   * function data (built via `buildFunctionParamMap`). Keyed by role so that
   * different roles scoping the same function on the same target (e.g. each
   * protocol's `approve(USDC)` with its own spender) render their OWN
   * constraints. When present, every matching
   * `scopeFunction` planned call expands into a foundry-style subtree
   * showing each scoped argument's type, name, and constraint. Missing
   * entries fall back to a leaf call node.
   */
  functionParamMap?: Record<string, FunctionParams>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Shorten an Ethereum address to `0xABCD…1234` (first 4 hex after `0x` +
 * ellipsis + last 4 hex). Preserves casing — pass a checksum address in
 * to keep the checksum visible. Non-address strings (e.g. roleKeys that
 * fell back to raw hex) are passed through unchanged.
 */
function shortAddr(addr: string): string {
  if (!ADDRESS_RE.test(addr)) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Address with optional `(label)` suffix from the alias registry. */
function addrWithLabel(addr: string, addressLabelMap: Record<string, string> | undefined): string {
  const short = shortAddr(addr);
  const label = addressLabelMap?.[addr.toLowerCase()];
  return label === undefined ? short : `${short} (${label})`;
}

/** Function identifier for call headers — name when known, raw selector otherwise. */
function fnIdent(selector: string, name: string | undefined): string {
  return name === undefined ? selector : name;
}

/**
 * Render a list of tree nodes as `├─`/`└─`-connected lines. `prefix` is
 * the indentation accumulated by the caller — at the root it's the
 * leading spaces inside the section; recursion appends `│   ` for
 * non-last siblings, `    ` for the last.
 */
function renderTreeLines(nodes: readonly TreeNode[], prefix: string): string[] {
  const lines: string[] = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└─ ' : '├─ ';
    lines.push(`${prefix}${connector}${node.label}`);
    if (node.children && node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      lines.push(...renderTreeLines(node.children, childPrefix));
    }
  });
  return lines;
}

/**
 * Build a single decoded call's tree node. `scopeFunction` calls with a
 * matching `functionParamMap` entry get a children subtree from
 * `renderParamTree`; everything else is a leaf.
 */
function callNode(
  call: DecodedCall,
  opts: {
    addressLabelMap?: Record<string, string>;
    functionParamMap?: Record<string, FunctionParams>;
  },
): TreeNode {
  switch (call.kind) {
    case 'scopeTarget':
    case 'revokeTarget':
    case 'allowTarget':
      return { label: `${call.kind}(${addrWithLabel(call.target, opts.addressLabelMap)})` };
    case 'scopeFunction': {
      const fn =
        opts.functionParamMap?.[
          `${call.roleKey}:${call.target.toLowerCase()}:${call.fnSelector.toLowerCase()}`
        ];
      // Source-side fnName fills in when the selectorMap didn't cover it —
      // both maps originate from the same generated YAMLs, so falling back
      // is consistent (and avoids showing the raw selector when we just
      // expanded the params underneath it).
      const fnNameDisplay = call.fnName ?? fn?.fnName;
      const head = `${call.kind}(${addrWithLabel(call.target, opts.addressLabelMap)}, ${fnIdent(call.fnSelector, fnNameDisplay)})`;
      if (fn === undefined) return { label: head };
      const children = renderParamTree(fn, opts.addressLabelMap);
      if (children.length === 0) return { label: head };
      return { label: head, children };
    }
    case 'allowFunction':
    case 'revokeFunction':
    case 'unscopeFunction': {
      const fn =
        opts.functionParamMap?.[
          `${call.roleKey}:${call.target.toLowerCase()}:${call.fnSelector.toLowerCase()}`
        ];
      const fnNameDisplay = call.fnName ?? fn?.fnName;
      return {
        label: `${call.kind}(${addrWithLabel(call.target, opts.addressLabelMap)}, ${fnIdent(call.fnSelector, fnNameDisplay)})`,
      };
    }
    case 'assignRoles': {
      const roles = `[${call.roleKeys.join(', ')}]`;
      const flags = `[${call.assigned.map((b) => String(b)).join(', ')}]`;
      return { label: `member=${shortAddr(call.member)} roles=${roles} assigned=${flags}` };
    }
    case 'setGuard':
      return { label: `setGuard(${addrWithLabel(call.guardAddress, opts.addressLabelMap)})` };
    case 'setFallbackHandler':
      return {
        label: `setFallbackHandler(${addrWithLabel(call.fallbackAddress, opts.addressLabelMap)})`,
      };
    case 'enableModule':
      return { label: `enableModule(${addrWithLabel(call.moduleAddress, opts.addressLabelMap)})` };
    case 'disableModule':
      // Render ONLY `moduleAddress` — `prevModule` is an on-chain
      // linked-list implementation detail that adds no signal to the diff.
      return {
        label: `disableModule(${addrWithLabel(call.moduleAddress, opts.addressLabelMap)})`,
      };
    case 'unknown':
      return { label: `unknown(selector=${call.selector}, dataLen=${call.dataLen})` };
  }
}

interface Groups {
  /** Safe-level calls (setGuard / setFallbackHandler / enable / disable Module). */
  safeCalls: DecodedCall[];
  /** Revoke calls grouped by decoded role key. */
  revokesByRole: Map<string, DecodedCall[]>;
  /** Scope/allow/unscope calls grouped by decoded role key. */
  scopesByRole: Map<string, DecodedCall[]>;
  /** Every assignRoles call, in input order. */
  assignRoles: Array<Extract<DecodedCall, { kind: 'assignRoles' }>>;
  /** Unknown calls, in input order. */
  unknowns: Array<Extract<DecodedCall, { kind: 'unknown' }>>;
  /** Total counts per section (for the section headers). */
  safeCount: number;
  revokeCount: number;
  addCount: number;
}

function classify(decoded: DecodedCall[]): Groups {
  const safeCalls: DecodedCall[] = [];
  const revokesByRole = new Map<string, DecodedCall[]>();
  const scopesByRole = new Map<string, DecodedCall[]>();
  const assignRoles: Groups['assignRoles'] = [];
  const unknowns: Groups['unknowns'] = [];
  let safeCount = 0;
  let revokeCount = 0;
  let addCount = 0;

  function pushTo(map: Map<string, DecodedCall[]>, key: string, call: DecodedCall): void {
    const list = map.get(key);
    if (list === undefined) map.set(key, [call]);
    else list.push(call);
  }

  for (const call of decoded) {
    switch (call.kind) {
      case 'setGuard':
      case 'setFallbackHandler':
      case 'enableModule':
      case 'disableModule':
        safeCalls.push(call);
        safeCount += 1;
        break;
      case 'revokeTarget':
      case 'revokeFunction':
        pushTo(revokesByRole, call.roleKey, call);
        revokeCount += 1;
        break;
      case 'scopeTarget':
      case 'scopeFunction':
      case 'allowTarget':
      case 'allowFunction':
      case 'unscopeFunction':
        pushTo(scopesByRole, call.roleKey, call);
        addCount += 1;
        break;
      case 'assignRoles':
        assignRoles.push(call);
        addCount += 1;
        break;
      case 'unknown':
        unknowns.push(call);
        addCount += 1;
        break;
    }
  }

  return {
    safeCalls,
    revokesByRole,
    scopesByRole,
    assignRoles,
    unknowns,
    safeCount,
    revokeCount,
    addCount,
  };
}

/**
 * Sort decoded calls inside a role-key group: targets before their
 * functions, and functions for the same target stay adjacent.
 */
function sortCallsForGroup(calls: DecodedCall[]): DecodedCall[] {
  const priority = (k: DecodedCall['kind']): number => {
    switch (k) {
      case 'scopeTarget':
      case 'revokeTarget':
      case 'allowTarget':
        return 0;
      case 'scopeFunction':
      case 'allowFunction':
      case 'revokeFunction':
      case 'unscopeFunction':
        return 1;
      default:
        return 2;
    }
  };
  const targetOf = (c: DecodedCall): string => {
    if ('target' in c) return c.target.toLowerCase();
    return '';
  };
  return [...calls].sort((a, b) => {
    const ta = targetOf(a);
    const tb = targetOf(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return priority(a.kind) - priority(b.kind);
  });
}

/**
 * Print the diff for one Plan to `opts.out` as a single foundry-style
 * tree rooted at the plan header. Header is always emitted (caller
 * guards against empty plans — `runPlan` / `runPlanForSafeDir` throw
 * before reaching the printer when zero calls were computed).
 */
export function printPlanDiff(plan: Plan, opts: PrintPlanDiffOpts): void {
  const out = opts.out ?? process.stdout;
  const decoded = plan.calls.map((c) =>
    decodeCall(c, opts.sdk, opts.selectorMap, opts.safeAddress),
  );
  const groups = classify(decoded);

  const callOpts = {
    ...(opts.addressLabelMap !== undefined ? { addressLabelMap: opts.addressLabelMap } : {}),
    ...(opts.functionParamMap !== undefined ? { functionParamMap: opts.functionParamMap } : {}),
  };

  // Section: safe (Safe-level reconcile calls — setGuard, setFallbackHandler,
  // enable/disableModule). Rendered FIRST when present.
  const safeSection: TreeNode | undefined =
    groups.safeCount > 0
      ? {
          label: `safe (${groups.safeCount})`,
          children: groups.safeCalls.map((c) => callNode(c, callOpts)),
        }
      : undefined;

  // Section: revokes.
  const revokeSection: TreeNode | undefined =
    groups.revokeCount > 0
      ? {
          label: `revokes (${groups.revokeCount})`,
          children: [...groups.revokesByRole.keys()].sort().map((roleKey) => {
            const calls = sortCallsForGroup(groups.revokesByRole.get(roleKey) ?? []);
            const unmentioned =
              opts.declaredRoleKeys !== undefined && !opts.declaredRoleKeys.has(roleKey);
            const label = unmentioned ? `${roleKey}  ⚠ not declared in any source` : roleKey;
            return { label, children: calls.map((c) => callNode(c, callOpts)) };
          }),
        }
      : undefined;

  // Section: adds.
  const addSection: TreeNode | undefined =
    groups.addCount > 0
      ? {
          label: `adds (${groups.addCount})`,
          children: (() => {
            const children: TreeNode[] = [];
            for (const roleKey of [...groups.scopesByRole.keys()].sort()) {
              const calls = sortCallsForGroup(groups.scopesByRole.get(roleKey) ?? []);
              children.push({ label: roleKey, children: calls.map((c) => callNode(c, callOpts)) });
            }
            if (groups.assignRoles.length > 0) {
              children.push({
                label: 'assignRoles',
                children: groups.assignRoles.map((c) => callNode(c, callOpts)),
              });
            }
            if (groups.unknowns.length > 0) {
              children.push({
                label: 'unknown',
                children: groups.unknowns.map((c) => callNode(c, callOpts)),
              });
            }
            return children;
          })(),
        }
      : undefined;

  const topNodes: TreeNode[] = [];
  if (safeSection) topNodes.push(safeSection);
  if (revokeSection) topNodes.push(revokeSection);
  if (addSection) topNodes.push(addSection);

  const lines: string[] = [];
  lines.push(`plan: ${opts.planPath} (${plan.calls.length} calls)`);
  lines.push(...renderTreeLines(topNodes, ''));
  out.write(lines.join('\n') + '\n');
}
