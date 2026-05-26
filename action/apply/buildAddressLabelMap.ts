import type { AliasRegistry } from '../load/loadAllAliases';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
 * First-seen wins on collisions — the registry's iteration order is
 * stable (Object.entries) so behavior is deterministic per input. Non-
 * address strings (e.g. `asset: "USDC"` symbol references inside
 * metamorpho entries) are silently ignored by the regex filter.
 */
export function buildAddressLabelMap(aliases: AliasRegistry): Record<string, string> {
  const out = new Map<string, string>();
  for (const [namespace, value] of Object.entries(aliases.merged)) {
    flatten(value, [namespace], out);
  }
  return Object.fromEntries(out);
}

function flatten(node: unknown, path: string[], out: Map<string, string>): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (ADDRESS_RE.test(node)) {
      const key = node.toLowerCase();
      if (!out.has(key)) out.set(key, path.join('.'));
    }
    return;
  }
  if (typeof node !== 'object' || Array.isArray(node)) return;
  // Object: special-case `{address: "0x...", ...}` so the metamorpho-style
  // entries map to the parent path (not `<entry>.address`). The sibling
  // fields (e.g. `asset: "USDC"`) are symbol references — not addresses —
  // so dropping the rest of the descent loses nothing.
  const obj = node as Record<string, unknown>;
  if (typeof obj['address'] === 'string' && ADDRESS_RE.test(obj['address'])) {
    const key = obj['address'].toLowerCase();
    if (!out.has(key)) out.set(key, path.join('.'));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    flatten(v, [...path, k], out);
  }
}
