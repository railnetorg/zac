import { parseAbiItem, toFunctionSelector } from 'viem';
import type { Generated } from './parseGenerated';

/**
 * A viem-parsed ABI input — recurses for tuple components. Mirrors the
 * structure already used inside `toSdkTargets` for scoping translation.
 */
export interface AbiInput {
  name?: string;
  type: string;
  components?: AbiInput[];
}

/**
 * Source-side data for one scoped function permission. The `inputs` come
 * from parsing the signature; `params` come straight from the user's
 * `params:` block (passthrough). The printer pairs them positionally
 * by name to render `<type> <name>  <constraint>` lines.
 */
export interface FunctionParams {
  signature: string;
  fnName: string;
  inputs: AbiInput[];
  params: Array<Record<string, unknown> & { name: string; operator?: string }>;
  /** Present when the function root is an `or` of branches (per-branch param sets). */
  branches?: Array<{
    params?: Array<Record<string, unknown> & { name: string; operator?: string }>;
  }>;
}

/**
 * Walk parsed `Generated` configs and produce a lookup keyed by
 * `<roleKey>:<target_lower>:<selector_lower>` → source-side function data.
 * Used by `printPlanDiff` to render scopeFunction permissions as a tree of
 * `<type> <name>  <constraint>` lines under each call.
 *
 * The key INCLUDES the role key: different roles routinely scope the SAME
 * function on the SAME target with DIFFERENT conditions (e.g. every protocol
 * config approves `tokens.USDC`, each pinning its own spender). Keying by
 * `<target>:<selector>` alone collided them, so every `approve(USDC)` line
 * rendered the first-seen role's spender (e.g. the Aave pool everywhere).
 * A genuine collision WITHIN one `(role, target, selector)` keeps the first
 * occurrence, to be deterministic.
 *
 * Signatures that fail to parse are skipped silently — the printer falls
 * back to a leaf call line for missing entries.
 */
export function buildFunctionParamMap(generatedList: Generated[]): Record<string, FunctionParams> {
  const map: Record<string, FunctionParams> = {};
  for (const generated of generatedList) {
    for (const [roleKey, role] of Object.entries(generated.roles)) {
      for (const target of role.targets) {
        const addr = target.address.toLowerCase();
        for (const fn of target.functions) {
          let selector: string;
          let inputs: AbiInput[];
          let fnName: string;
          try {
            selector = toFunctionSelector(fn.signature).toLowerCase();
            const item = parseAbiItem(fn.signature) as unknown as {
              name: string;
              inputs: AbiInput[];
            };
            inputs = item.inputs ?? [];
            fnName = item.name;
          } catch {
            continue;
          }
          const key = `${roleKey}:${addr}:${selector}`;
          if (map[key] !== undefined) continue;
          const fnAny = fn as unknown as {
            params?: FunctionParams['params'];
            branches?: FunctionParams['branches'];
          };
          map[key] = {
            signature: fn.signature,
            fnName,
            inputs,
            params: fnAny.params ?? [],
            ...(fnAny.branches !== undefined ? { branches: fnAny.branches } : {}),
          };
        }
      }
    }
  }
  return map;
}
