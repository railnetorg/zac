import { decodeFunctionData, toFunctionSelector } from 'viem';
import type { PlanCall } from './planSchema';

/**
 * Minimal Safe ABI for the 4 Safe-level functions the diff renderer
 * recognizes. Parameters are EXPLICITLY NAMED so `decodeFunctionData`
 * returns them by name. Kept inline (rather than imported from a package)
 * because the dependency surface is tiny and the ABI is static.
 *
 * NOTE: `enableModule(0x610b5925)` and `disableModule(0xe009cfde)` are
 * SHARED with the Roles modifier ABI. To disambiguate at decode time,
 * the Safe-ABI dispatch is gated on `call.to === safeAddress` — see
 * `decodeCall` below.
 */
const SAFE_ABI = [
  {
    type: 'function',
    name: 'setGuard',
    inputs: [{ type: 'address', name: 'guard' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setFallbackHandler',
    inputs: [{ type: 'address', name: 'handler' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'enableModule',
    inputs: [{ type: 'address', name: 'module' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'disableModule',
    inputs: [
      { type: 'address', name: 'prevModule' },
      { type: 'address', name: 'module' },
    ],
    outputs: [],
  },
] as const;

/** Precomputed selectors for the 4 Safe-ABI functions (lowercase 0x-hex). */
const SAFE_SELECTORS: Record<string, true> = {
  [toFunctionSelector('function setGuard(address guard)')]: true,
  [toFunctionSelector('function setFallbackHandler(address handler)')]: true,
  [toFunctionSelector('function enableModule(address module)')]: true,
  [toFunctionSelector('function disableModule(address prevModule, address module)')]: true,
};

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
 * Roles V2 `ExecutionOptions`, in the lowercase spelling the DSL's
 * `execution_options` uses. The on-chain enum is
 * `None = 0 | Send = 1 | DelegateCall = 2 | Both = 3` — the ordering is
 * taken from `zodiac-roles-deployments`, which is where the SDK's own
 * `ExecutionOptions` comes from.
 */
export type ExecutionOptionsName = 'none' | 'send' | 'delegatecall' | 'both';

/** Enum name by raw uint8 value, indexed by the on-chain ordering. */
const EXECUTION_OPTIONS_NAMES: readonly ExecutionOptionsName[] = [
  'none',
  'send',
  'delegatecall',
  'both',
];

/**
 * A decoded `ExecutionOptions` argument. `raw` is carried alongside `name`
 * so a value outside the enum's 0..3 range stays visible in the diff
 * instead of being coerced into a name the calldata does not mean. The SDK
 * cannot emit such a value and the modifier would revert on it, but a plan
 * file is JSON on disk and `decodeCall` is what a signer reads it through.
 */
export interface DecodedExecutionOptions {
  /** The uint8 as it appears in calldata. */
  raw: number;
  /** Enum name; absent when `raw` is outside 0..3. */
  name?: ExecutionOptionsName;
}

/**
 * Decode the `ExecutionOptions` uint8 argument. viem hands back a `number`
 * for uint8; `Number()` also covers a bigint from a widened decoder. An
 * out-of-range value yields `{ raw }` with no `name`.
 */
function decodeExecutionOptions(arg: unknown): DecodedExecutionOptions {
  const raw = Number(arg);
  const name = EXECUTION_OPTIONS_NAMES[raw];
  return name === undefined ? { raw } : { raw, name };
}

/**
 * Tagged-union decode result, one variant per Roles modifier function we
 * recognize plus an `unknown` fallback. `roleKey` is the decoded
 * string-representation (e.g. `"ETHENA_INSTITUTIONAL"`); if the SDK's
 * `decodeKey` throws on the raw bytes32, we fall back to the raw hex.
 * `fnName` is the function name from the ERC20/Roles selector catalog
 * (e.g. `"approve"`), present only when we recognize the selector.
 *
 * The grant variants are split from the removal ones so `executionOptions`
 * is a required field exactly where the Roles ABI carries the argument
 * (`allowTarget`, `allowFunction`, `scopeFunction`) and is absent from the
 * type everywhere else. `scopeTarget`, `revokeTarget`, `revokeFunction` and
 * `unscopeFunction` take no options argument — a removal cannot grant one —
 * so there is nothing to read and nothing for the printer to show.
 */
export type DecodedCall =
  | {
      kind: 'assignRoles';
      member: `0x${string}`;
      roleKeys: string[];
      assigned: boolean[];
    }
  | {
      kind: 'scopeTarget' | 'revokeTarget';
      roleKey: string;
      target: `0x${string}`;
    }
  | {
      kind: 'allowTarget';
      roleKey: string;
      target: `0x${string}`;
      executionOptions: DecodedExecutionOptions;
    }
  | {
      kind: 'scopeFunction' | 'allowFunction';
      roleKey: string;
      target: `0x${string}`;
      fnSelector: `0x${string}`;
      fnName?: string;
      executionOptions: DecodedExecutionOptions;
    }
  | {
      kind: 'revokeFunction' | 'unscopeFunction';
      roleKey: string;
      target: `0x${string}`;
      fnSelector: `0x${string}`;
      fnName?: string;
    }
  | { kind: 'setGuard'; target: `0x${string}`; guardAddress: `0x${string}` }
  | { kind: 'setFallbackHandler'; target: `0x${string}`; fallbackAddress: `0x${string}` }
  | { kind: 'enableModule'; target: `0x${string}`; moduleAddress: `0x${string}` }
  | {
      kind: 'disableModule';
      target: `0x${string}`;
      prevModule: `0x${string}`;
      moduleAddress: `0x${string}`;
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
  safeAddress?: string,
): DecodedCall {
  const data = call.data;
  if (data.length < 10) {
    // Too short to extract a 4-byte selector — pad to bytes4 so the
    // printer always has a fixed-width selector to show.
    const padded = (data + '0'.repeat(Math.max(0, 10 - data.length))) as `0x${string}`;
    return { kind: 'unknown', selector: padded, dataLen: Math.max(0, (data.length - 2) / 2) };
  }
  const selector = data.slice(0, 10) as `0x${string}`;

  // Safe-ABI dispatch — gated by `call.to === safeAddress` to disambiguate
  // the `enableModule` / `disableModule` selector collision between Safe
  // and Roles modifier. Skipped entirely for legacy callers who pass no
  // `safeAddress`. When the gate matches but the selector isn't a Safe-ABI
  // function, fall through to the rolesAbi path (a Safe contract receives
  // ONLY Safe-ABI calls in practice, but the fallback keeps unknown
  // selectors decodable).
  if (
    safeAddress !== undefined &&
    call.to.toLowerCase() === safeAddress.toLowerCase() &&
    SAFE_SELECTORS[selector.toLowerCase()] === true
  ) {
    try {
      const safeDecoded = decodeFunctionData({
        abi: SAFE_ABI,
        data: data as `0x${string}`,
      }) as { functionName: string; args: readonly unknown[] };
      const target = call.to as `0x${string}`;
      switch (safeDecoded.functionName) {
        case 'setGuard':
          return { kind: 'setGuard', target, guardAddress: safeDecoded.args[0] as `0x${string}` };
        case 'setFallbackHandler':
          return {
            kind: 'setFallbackHandler',
            target,
            fallbackAddress: safeDecoded.args[0] as `0x${string}`,
          };
        case 'enableModule':
          return {
            kind: 'enableModule',
            target,
            moduleAddress: safeDecoded.args[0] as `0x${string}`,
          };
        case 'disableModule':
          return {
            kind: 'disableModule',
            target,
            prevModule: safeDecoded.args[0] as `0x${string}`,
            moduleAddress: safeDecoded.args[1] as `0x${string}`,
          };
      }
    } catch {
      // Fall through — try rolesAbi path. (This branch is unreachable in
      // practice because the selector pre-check guarantees a successful
      // Safe-ABI decode, but defensive code keeps the printer robust.)
    }
  }

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
    case 'revokeTarget': {
      // scopeTarget(roleKey, target) / revokeTarget(roleKey, target) — no
      // options argument on either.
      const roleKey = safeDecodeKey(sdk, args[0] as `0x${string}`);
      const target = args[1] as `0x${string}`;
      return { kind: name, roleKey, target };
    }
    case 'allowTarget': {
      // allowTarget(roleKey, target, options) — options at args[2].
      const roleKey = safeDecodeKey(sdk, args[0] as `0x${string}`);
      const target = args[1] as `0x${string}`;
      return {
        kind: 'allowTarget',
        roleKey,
        target,
        executionOptions: decodeExecutionOptions(args[2]),
      };
    }
    case 'scopeFunction':
    case 'allowFunction': {
      // Options is the TRAILING argument of both, but NOT at the same index
      // (positions read off the SDK's `rolesAbi`):
      //   scopeFunction(roleKey, target, selector, conditions, options) → args[4]
      //   allowFunction(roleKey, target, selector, options)             → args[3]
      const roleKey = safeDecodeKey(sdk, args[0] as `0x${string}`);
      const target = args[1] as `0x${string}`;
      const fnSelector = args[2] as `0x${string}`;
      const fnName = lookupFnName(fnSelector, extraSelectors);
      const optionsArg = name === 'scopeFunction' ? args[4] : args[3];
      const out: DecodedCall = {
        kind: name,
        roleKey,
        target,
        fnSelector,
        executionOptions: decodeExecutionOptions(optionsArg),
      };
      if (fnName !== undefined) out.fnName = fnName;
      return out;
    }
    case 'revokeFunction':
    case 'unscopeFunction': {
      // revokeFunction(roleKey, target, selector) takes no options argument
      // (and `unscopeFunction` is not in the Roles ABI at all). Nothing is
      // read past args[2], so the field stays absent rather than being set
      // to `undefined` from a missing arg.
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
