import { decodeCall, type DecodeSdk, type DecodedCall } from './decodeCall';
import type { Plan } from './planSchema';

export interface PrintPlanDiffOpts {
  /** Human-friendly path for the header line — caller should pre-apply `displayPath`. */
  planPath: string;
  /**
   * Role keys declared in the safe-dir's sources (decoded string form).
   * Present ONLY in per-safe-dir mode. When set, revokes targeting role
   * keys NOT in this set trigger an "unmentioned" warning at the bottom.
   * When undefined (legacy per-file mode), no warning is printed.
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
   * to their human name in the `fn=…` suffix. Unknown selectors still
   * fall through to raw hex.
   */
  selectorMap?: Record<string, string>;
}

/** Section dividers — fixed width 56 chars including header text. */
const REVOKES_HEADER_PAD = '─'.repeat(20);
const ADDS_HEADER_PAD = '─'.repeat(18);

/**
 * Shorten an Ethereum address to `0xABCD…1234` (first 4 hex after `0x` +
 * ellipsis + last 4 hex). Preserves casing — pass a checksum address in
 * to keep the checksum visible. Non-address strings (e.g. roleKeys that
 * fell back to raw hex) are passed through unchanged.
 */
function shortAddr(addr: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Pretty-print an `fn=<selector>` suffix, adding `(<name>)` when known. */
function fnSuffix(selector: string, name: string | undefined): string {
  if (name === undefined) return `fn=${selector}`;
  return `fn=${selector} (${name})`;
}

interface Groups {
  /** Revoke calls grouped by decoded role key. */
  revokesByRole: Map<string, DecodedCall[]>;
  /** Scope/allow/unscope calls grouped by decoded role key. */
  scopesByRole: Map<string, DecodedCall[]>;
  /** Every assignRoles call, in input order. */
  assignRoles: Array<Extract<DecodedCall, { kind: 'assignRoles' }>>;
  /** Unknown calls, in input order. */
  unknowns: Array<Extract<DecodedCall, { kind: 'unknown' }>>;
  /** Total counts per section (for the section headers). */
  revokeCount: number;
  addCount: number;
}

function classify(decoded: DecodedCall[]): Groups {
  const revokesByRole = new Map<string, DecodedCall[]>();
  const scopesByRole = new Map<string, DecodedCall[]>();
  const assignRoles: Groups['assignRoles'] = [];
  const unknowns: Groups['unknowns'] = [];
  let revokeCount = 0;
  let addCount = 0;

  function pushTo(map: Map<string, DecodedCall[]>, key: string, call: DecodedCall): void {
    const list = map.get(key);
    if (list === undefined) map.set(key, [call]);
    else list.push(call);
  }

  for (const call of decoded) {
    switch (call.kind) {
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
        // assignRoles is shown in the "adds / changes" section regardless of
        // direction — the `assigned=[...]` line makes direction explicit so
        // the user sees grants and removals together for one member.
        assignRoles.push(call);
        addCount += 1;
        break;
      case 'unknown':
        unknowns.push(call);
        addCount += 1;
        break;
    }
  }

  return { revokesByRole, scopesByRole, assignRoles, unknowns, revokeCount, addCount };
}

/**
 * Sort decoded calls inside a role-key group: targets before their
 * functions, and functions for the same target stay adjacent.
 *
 * The original SDK call order already groups by `(target, fn)` for the
 * revoke path, so we just enforce the conventional ordering here for
 * stability across input orderings.
 */
function sortCallsForGroup(calls: DecodedCall[]): DecodedCall[] {
  // Stable sort by (target, kind-priority).
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
 * Count distinct targets and functions in a group — used for the role-key
 * sub-header `(N targets, M function permissions)`.
 */
function summarizeGroup(calls: DecodedCall[]): { targets: number; functions: number } {
  const targets = new Set<string>();
  let functions = 0;
  for (const c of calls) {
    if ('target' in c) targets.add(c.target.toLowerCase());
    if (
      c.kind === 'revokeFunction' ||
      c.kind === 'scopeFunction' ||
      c.kind === 'allowFunction' ||
      c.kind === 'unscopeFunction'
    ) {
      functions += 1;
    }
  }
  return { targets: targets.size, functions };
}

/** Format one decoded call as a single indented line. */
function formatCallLine(call: DecodedCall): string {
  switch (call.kind) {
    case 'scopeTarget':
    case 'revokeTarget':
    case 'allowTarget':
      return `    ${call.kind.padEnd(15)}target=${shortAddr(call.target)}`;
    case 'scopeFunction':
    case 'allowFunction':
    case 'revokeFunction':
    case 'unscopeFunction':
      return `    ${call.kind.padEnd(15)}target=${shortAddr(call.target)}  ${fnSuffix(
        call.fnSelector,
        call.fnName,
      )}`;
    case 'unknown':
      return `    unknown        selector=${call.selector}  dataLen=${call.dataLen}`;
    case 'assignRoles':
      // assignRoles is rendered as its own block; this branch is unused.
      return '';
  }
}

function formatAssignRolesLine(call: Extract<DecodedCall, { kind: 'assignRoles' }>): string {
  const roles = `[${call.roleKeys.join(', ')}]`;
  const flags = `[${call.assigned.map((b) => String(b)).join(', ')}]`;
  return `    member=${shortAddr(call.member)}  roles=${roles}      assigned=${flags}`;
}

/**
 * Print the diff for one Plan to `opts.out`. Header is always emitted
 * (caller guards against empty plans — `runPlan` / `runPlanForSafeDir`
 * throw before reaching the printer when zero calls were computed).
 */
export function printPlanDiff(plan: Plan, opts: PrintPlanDiffOpts): void {
  const out = opts.out ?? process.stdout;
  const decoded = plan.calls.map((c) => decodeCall(c, opts.sdk, opts.selectorMap));
  const groups = classify(decoded);

  const lines: string[] = [];
  lines.push(`plan: ${opts.planPath} (${plan.calls.length} calls)`);
  lines.push('');

  if (groups.revokeCount > 0) {
    lines.push(`  ── revokes (${groups.revokeCount}) ${REVOKES_HEADER_PAD}`);
    // Stable role-key order: alphabetical (decoded form).
    const roleKeys = [...groups.revokesByRole.keys()].sort();
    for (const roleKey of roleKeys) {
      const calls = sortCallsForGroup(groups.revokesByRole.get(roleKey) ?? []);
      const summary = summarizeGroup(calls);
      const targetsLabel = summary.targets === 1 ? '1 target' : `${summary.targets} targets`;
      const fnsLabel =
        summary.functions === 1
          ? '1 function permission'
          : `${summary.functions} function permissions`;
      lines.push(`  ${roleKey}  (${targetsLabel}, ${fnsLabel})`);
      for (const c of calls) lines.push(formatCallLine(c));
    }
    lines.push('');
  }

  if (groups.addCount > 0) {
    lines.push(`  ── adds / changes (${groups.addCount}) ${ADDS_HEADER_PAD}`);
    const roleKeys = [...groups.scopesByRole.keys()].sort();
    for (const roleKey of roleKeys) {
      const calls = sortCallsForGroup(groups.scopesByRole.get(roleKey) ?? []);
      lines.push(`  ${roleKey}`);
      for (const c of calls) lines.push(formatCallLine(c));
    }
    if (groups.assignRoles.length > 0) {
      lines.push(`  assignRoles`);
      for (const c of groups.assignRoles) lines.push(formatAssignRolesLine(c));
    }
    if (groups.unknowns.length > 0) {
      lines.push(`  unknown`);
      for (const c of groups.unknowns) lines.push(formatCallLine(c));
    }
    lines.push('');
  }

  // Unmentioned-revokes warning — per-safe-dir mode only.
  if (opts.declaredRoleKeys !== undefined && groups.revokeCount > 0) {
    const unmentioned = new Set<string>();
    for (const roleKey of groups.revokesByRole.keys()) {
      if (!opts.declaredRoleKeys.has(roleKey)) unmentioned.add(roleKey);
    }
    if (unmentioned.size > 0) {
      const list = [...unmentioned].sort().join(', ');
      const n = unmentioned.size;
      lines.push(`  ⚠ revoking ${n} role(s) not declared in any source: ${list}`);
      lines.push(`     pass --revoke-unmentioned=false to preserve them, or add .zac.yaml entries`);
      lines.push('');
    }
  }

  out.write(lines.join('\n') + '\n');
}
