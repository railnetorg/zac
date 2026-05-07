import { parseAbiItem } from 'viem';
import { ZacError } from '../errors';
import type { Generated } from './parseGenerated';

interface ParamYaml {
  name: string;
  operator: string;
  value?: unknown;
  values?: unknown[];
  value_type?: string;
}

interface SdkBuilders {
  c: {
    eq: (v: unknown) => unknown;
    gt: (v: unknown) => unknown;
    lt: (v: unknown) => unknown;
    or: (...args: unknown[]) => unknown;
    calldataMatches: (scoping: unknown, abiTypes: readonly string[]) => unknown;
    avatar: unknown;
  };
  processPermissions: (perms: unknown[]) => { targets: unknown[] };
}

function buildScopingForParam(p: ParamYaml, c: SdkBuilders['c']): unknown {
  switch (p.operator) {
    case 'pass':
      return undefined;
    case 'equal_to':
      return c.eq(p.value);
    case 'equal_to_avatar':
      return c.avatar;
    case 'oneOf':
      return c.or(...(p.values ?? []).map((v) => c.eq(v)));
    case 'greater_than':
    case 'signed_int_greater_than':
      return c.gt(p.value);
    case 'less_than':
    case 'signed_int_less_than':
      return c.lt(p.value);
    default:
      throw new ZacError({
        phase: 'apply',
        message: `unsupported operator '${p.operator}' for param '${p.name}' (composite ops not yet wired into apply)`,
      });
  }
}

function buildPositionalScoping(
  params: ParamYaml[] | undefined,
  signature: string,
  c: SdkBuilders['c'],
): { scoping: unknown[]; abiTypes: string[] } | null {
  const item = parseAbiItem(signature) as unknown as {
    inputs: Array<{ name?: string; type: string }>;
  };
  const inputs = item.inputs ?? [];
  if (inputs.length === 0) return null;
  const abiTypes = inputs.map((i) => i.type);
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
    const s = buildScopingForParam(p, c);
    if (s !== undefined) allPass = false;
    out.push(s);
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
