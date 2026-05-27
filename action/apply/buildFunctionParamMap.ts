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
  params: Array<Record<string, unknown> & { name: string; operator: string }>;
}

/**
 * Walk parsed `Generated` configs and produce a lookup keyed by
 * `<target_lower>:<selector_lower>` → source-side function data. Used by
 * `printPlanDiff` to render scopeFunction permissions as a tree of
 * `<type> <name>  <constraint>` lines under each call.
 *
 * Selector collisions across different targets are not a concern — the
 * key includes the target. Same selector on the same target collides; we
 * keep the first occurrence to be deterministic (matches `buildSelectorMap`).
 *
 * Signatures that fail to parse are skipped silently — the printer falls
 * back to a leaf call line for missing entries.
 */
export function buildFunctionParamMap(generatedList: Generated[]): Record<string, FunctionParams> {
  const map: Record<string, FunctionParams> = {};
  for (const generated of generatedList) {
    for (const role of Object.values(generated.roles)) {
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
          const key = `${addr}:${selector}`;
          if (map[key] !== undefined) continue;
          map[key] = {
            signature: fn.signature,
            fnName,
            inputs,
            params: fn.params ?? [],
          };
        }
      }
    }
  }
  return map;
}
