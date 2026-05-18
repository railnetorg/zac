import { decodeFunctionData } from 'viem';
import type { PlanCall } from './planSchema';

/**
 * SDK surface needed by `decodeCall`. Injected so unit tests can stub the
 * SDK and so the CLI can pass the lazily-imported runtime instance.
 *
 * `rolesAbi` is the readonly tuple ABI exported by `zodiac-roles-sdk`; we
 * type it loosely here because viem's `decodeFunctionData` accepts any
 * shape that matches the `Abi` interface (the SDK's `as const` ABI does).
 * `decodeKey` recovers the original string representation from the SDK's
 * `encodeKey` output, or throws when fed binary garbage — wrap calls in
 * try/catch and fall back to raw hex.
 */
export interface DecodeSdk {
  rolesAbi: readonly unknown[];
  decodeKey: (key: string) => string;
}

/**
 * Tagged-union decode result, one variant per Roles modifier function we
 * recognize plus an `unknown` fallback. `roleKey` is the decoded
 * string-representation (e.g. `"ETHENA_INSTITUTIONAL"`); if the SDK's
 * `decodeKey` throws on the raw bytes32, we fall back to the raw hex.
 * `fnName` is the function name from the ERC20/Roles selector catalog
 * (e.g. `"approve"`), present only when we recognize the selector.
 */
export type DecodedCall =
  | {
      kind: 'assignRoles';
      member: `0x${string}`;
      roleKeys: string[];
      assigned: boolean[];
    }
  | {
      kind: 'scopeTarget' | 'revokeTarget' | 'allowTarget';
      roleKey: string;
      target: `0x${string}`;
    }
  | {
      kind: 'scopeFunction' | 'revokeFunction' | 'unscopeFunction';
      roleKey: string;
      target: `0x${string}`;
      fnSelector: `0x${string}`;
      fnName?: string;
    }
  | { kind: 'unknown'; selector: `0x${string}`; dataLen: number };

/**
 * Common ERC20 selectors — used to annotate `fnName` on
 * `scopeFunction` / `revokeFunction` decoded calls. The Roles ABI itself
 * doesn't know about these (the modifier scopes them as opaque 4-byte
 * selectors); we provide the human label so users don't have to look
 * `0x095ea7b3` up by hand. Unknown selectors are left without a `fnName`.
 */
const ERC20_SELECTOR_NAMES: Record<string, string> = {
  '0x095ea7b3': 'approve',
  '0xa9059cbb': 'transfer',
  '0x23b872dd': 'transferFrom',
};

function lookupFnName(
  selector: string,
  extraSelectors?: Record<string, string>,
): string | undefined {
  const key = selector.toLowerCase();
  return extraSelectors?.[key] ?? ERC20_SELECTOR_NAMES[key];
}

function safeDecodeKey(sdk: DecodeSdk, raw: `0x${string}`): string {
  try {
    return sdk.decodeKey(raw);
  } catch {
    // SDK throws on binary garbage in roleKey bytes — fall back to raw hex.
    return raw;
  }
}

/**
 * Decode a single planned call. Returns a typed variant the printer can
 * format; unrecognized selectors produce `{ kind: 'unknown' }` so the
 * printer still has a length / selector to show.
 *
 * Decoding leans on viem's `decodeFunctionData` + the SDK's exported
 * `rolesAbi` to handle the dynamic-array `assignRoles` shape without
 * re-implementing ABI offsets. Calldata shorter than 4 bytes is treated
 * as unknown.
 */
export function decodeCall(
  call: PlanCall,
  sdk: DecodeSdk,
  extraSelectors?: Record<string, string>,
): DecodedCall {
  const data = call.data;
  if (data.length < 10) {
    // Too short to extract a 4-byte selector — pad to bytes4 so the
    // printer always has a fixed-width selector to show.
    const padded = (data + '0'.repeat(Math.max(0, 10 - data.length))) as `0x${string}`;
    return { kind: 'unknown', selector: padded, dataLen: Math.max(0, (data.length - 2) / 2) };
  }
  const selector = data.slice(0, 10) as `0x${string}`;

  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({
      // Cast through unknown — the SDK's `as const` ABI satisfies viem's
      // `Abi` shape but our injected type widens it for stubbing.
      abi: sdk.rolesAbi as unknown as Parameters<typeof decodeFunctionData>[0]['abi'],
      data: data as `0x${string}`,
    }) as { functionName: string; args: readonly unknown[] };
  } catch {
    return { kind: 'unknown', selector, dataLen: (data.length - 2) / 2 };
  }

  const name = decoded.functionName;
  const args = decoded.args;
  switch (name) {
    case 'assignRoles': {
      const member = args[0] as `0x${string}`;
      const rawKeys = args[1] as readonly `0x${string}`[];
      const assigned = [...(args[2] as readonly boolean[])];
      const roleKeys = rawKeys.map((k) => safeDecodeKey(sdk, k));
      return { kind: 'assignRoles', member, roleKeys, assigned };
    }
    case 'scopeTarget':
    case 'revokeTarget':
    case 'allowTarget': {
      const roleKey = safeDecodeKey(sdk, args[0] as `0x${string}`);
      const target = args[1] as `0x${string}`;
      return { kind: name, roleKey, target };
    }
    case 'scopeFunction':
    case 'revokeFunction':
    case 'unscopeFunction': {
      const roleKey = safeDecodeKey(sdk, args[0] as `0x${string}`);
      const target = args[1] as `0x${string}`;
      const fnSelector = args[2] as `0x${string}`;
      const fnName = lookupFnName(fnSelector, extraSelectors);
      const out: DecodedCall = { kind: name, roleKey, target, fnSelector };
      if (fnName !== undefined) out.fnName = fnName;
      return out;
    }
    default:
      return { kind: 'unknown', selector, dataLen: (data.length - 2) / 2 };
  }
}
