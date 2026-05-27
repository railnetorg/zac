import type { AliasRegistry } from '../load/loadAllAliases';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Namespaces whose labels win collisions outright, in priority order.
 * `tokens` is the canonical home for ERC-20 symbols, so a target that is
 * also referenced incidentally inside a protocol config (e.g. USDC's
 * address appearing as `morpho_blue.markets.<m>.loan_token`) should still
 * render as `tokens.USDC`, not the deep market path.
 */
const PRIORITY_NAMESPACES = ['tokens'];

interface Candidate {
  label: string;
  /** [namespace-tier, path-depth] — lower is better. */
  prio: [number, number];
}

/**
 * Walk the merged alias registry and build a lookup of
 * lowercase-address → dotted-path label (e.g. `tokens.USDC`,
 * `aave.pool`, `metamorpho.steakhouse_usdc`). Used by `printPlanDiff` to
 * annotate `target=<addr>` lines with the alias key the user originally
 * referenced — counterpart of `buildSelectorMap` for function names.
 *
 * Three shapes are recognized:
 *   - flat string at a leaf: `tokens.USDC: "0x..."` → `tokens.USDC`
 *   - object with an `address` field: `metamorpho.steakhouse_usdc:
 *     { address: "0x...", asset: "USDC" }` → `metamorpho.steakhouse_usdc`
 *     (the parent path, not `steakhouse_usdc.address`)
 *   - nested namespace object (anything else): recurse with the key
 *     appended.
 *
 * Collisions (one address, several alias paths) resolve by priority:
 *   1. namespaces in `PRIORITY_NAMESPACES` (currently `tokens`) win, so
 *      asset symbols beat incidental protocol-config references;
 *   2. then the shallowest path (fewest dotted segments) wins, so a
 *      top-level `aave.pool` beats a nested `x.y.pool`;
 *   3. then first-seen wins (iteration order is stable).
 * Non-address strings (e.g. `asset: "USDC"` symbol references inside
 * metamorpho entries) are silently ignored by the regex filter.
 */
export function buildAddressLabelMap(aliases: AliasRegistry): Record<string, string> {
  const out = new Map<string, Candidate>();
  for (const [namespace, value] of Object.entries(aliases.merged)) {
    flatten(value, [namespace], out);
  }
  const result: Record<string, string> = {};
  for (const [addr, cand] of out) result[addr] = cand.label;
  return result;
}

/** Lower is better: priority-namespace tier first, then path depth. */
function priorityOf(path: string[]): [number, number] {
  const idx = PRIORITY_NAMESPACES.indexOf(path[0] ?? '');
  const tier = idx === -1 ? PRIORITY_NAMESPACES.length : idx;
  return [tier, path.length];
}

/** True when `a` should replace the currently-stored candidate `b`. */
function isBetter(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  return a[1] < b[1];
}

function record(key: string, path: string[], out: Map<string, Candidate>): void {
  const prio = priorityOf(path);
  const existing = out.get(key);
  if (existing === undefined || isBetter(prio, existing.prio)) {
    out.set(key, { label: path.join('.'), prio });
  }
}

function flatten(node: unknown, path: string[], out: Map<string, Candidate>): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (ADDRESS_RE.test(node)) record(node.toLowerCase(), path, out);
    return;
  }
  if (typeof node !== 'object' || Array.isArray(node)) return;
  // Object: special-case `{address: "0x...", ...}` so the metamorpho-style
  // entries map to the parent path (not `<entry>.address`). The sibling
  // fields (e.g. `asset: "USDC"`) are symbol references — not addresses —
  // so dropping the rest of the descent loses nothing.
  const obj = node as Record<string, unknown>;
  if (typeof obj['address'] === 'string' && ADDRESS_RE.test(obj['address'])) {
    record(obj['address'].toLowerCase(), path, out);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    flatten(v, [...path, k], out);
  }
}
