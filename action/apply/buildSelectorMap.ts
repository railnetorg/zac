import { toFunctionSelector } from 'viem';
import type { Generated } from './parseGenerated';

/**
 * Walk one or more parsed `Generated` configs and build a lookup map of
 * selector → function name, derived from every `signature` field under
 * `roles[].targets[].functions[]`. Used by `printPlanDiff` to annotate
 * `scopeFunction` / `revokeFunction` calls with the human function name
 * from the user's own sources (beyond the small ERC20 catalog baked into
 * `decodeCall`).
 *
 * Signature format is whatever the user wrote: viem's `toFunctionSelector`
 * accepts both `transfer(address,uint256)` and the human-readable
 * `function transfer(address to, uint256 amount)`. The returned name is
 * extracted from the signature (substring before the opening paren,
 * stripping any `function ` prefix).
 *
 * Selectors are lowercased for case-insensitive lookup. Conflicting
 * signatures (same selector, different name — won't happen with valid
 * ABIs but defensive) keep the FIRST entry encountered.
 *
 * Invalid signatures are silently skipped — the rest of the map still
 * works. We never throw from here.
 */
export function buildSelectorMap(generatedList: Generated[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const generated of generatedList) {
    for (const role of Object.values(generated.roles)) {
      for (const target of role.targets) {
        for (const fn of target.functions) {
          const sig = fn.signature;
          let selector: string;
          try {
            selector = toFunctionSelector(sig).toLowerCase();
          } catch {
            continue;
          }
          if (map[selector] !== undefined) continue;
          const name = extractFunctionName(sig);
          if (name !== undefined) map[selector] = name;
        }
      }
    }
  }
  return map;
}

/**
 * Extract the function name from a human-readable signature:
 * - `function approve(address spender, uint256 amount)` → `approve`
 * - `approve(address,uint256)` → `approve`
 * Returns undefined if the signature is malformed.
 */
function extractFunctionName(sig: string): string | undefined {
  const trimmed = sig.trim().replace(/^function\s+/, '');
  const paren = trimmed.indexOf('(');
  if (paren <= 0) return undefined;
  return trimmed.slice(0, paren).trim() || undefined;
}
