/**
 * applyOnFork: take the apply pipeline's `Generated` YAML object, run the
 * real `planApplyRole` from `zodiac-roles-sdk`, and execute each returned
 * call as a Safe `execTransaction` against the freshly deployed modifier.
 *
 * This deliberately bypasses Safe TX Service (apply/safeApi.ts). Apply's
 * posting layer is what we skip here — the call planning is what we
 * exercise.
 *
 * We also expose a `decodeScopingCall` helper so tests can log the planned
 * SDK calls in human-readable form before they're executed.
 */
import { decodeFunctionData, decodeErrorResult, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { rolesAbi } from 'zodiac-roles-sdk';
import { planRoleCalls, type PlanApplyRoleFn } from '../../apply/planRoleCalls';
import type { Generated } from '../../apply/parseGenerated';
import type { ForkContext } from './setup';

/**
 * Subset of `zodiac-roles-sdk`'s public surface that planRoleCalls needs.
 * Mirrors the shape declared inline in apply/planRoleCalls.ts so we don't
 * accidentally drift.
 */
interface SdkBundle {
  planApplyRole: PlanApplyRoleFn;
  encodeKey: (key: string) => `0x${string}`;
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

/** Lazily import the SDK so we keep the indirection consistent with planRoleCalls. */
async function loadSdk(): Promise<SdkBundle> {
  const mod = (await import('zodiac-roles-sdk')) as unknown as SdkBundle;
  return mod;
}

/**
 * Replace the placeholder `safe_address` and `roles_modifier_address` in a
 * fixture Generated with the freshly deployed addresses, so plan output
 * targets the right modifier.
 */
export function rebindAddresses(
  generated: Generated,
  safeAddress: Address,
  rolesAddress: Address,
): Generated {
  return {
    ...generated,
    deployment: {
      ...generated.deployment,
      safe_address: safeAddress,
      roles_modifier_address: rolesAddress,
    },
  };
}

/**
 * Pretty-print a single planned scoping call: decode the function name + a
 * couple of headline args and log them. Best-effort — falls back to the raw
 * 4-byte selector if decoding fails (e.g. for SDK-internal call shapes the
 * exported ABI doesn't model).
 */
export function logScopingCall(label: string, to: Address, data: Hex): void {
  try {
    const decoded = decodeFunctionData({ abi: rolesAbi, data });
    const selector = data.slice(0, 10);
    console.log(
      `[apply-on-fork] ${label} -> ${to} ${selector} ${decoded.functionName}(${decoded.args.length} args)`,
    );
  } catch {
    console.log(`[apply-on-fork] ${label} -> ${to} ${data.slice(0, 10)} (undecoded)`);
  }
}

/**
 * Run planApplyRole against `generated`, execute every returned call as the
 * Safe, and return the receipts so callers can assert on them.
 *
 * `generated` MUST already point at the deployed Safe + Roles modifier
 * addresses (use `rebindAddresses` for that).
 */
export async function applyGeneratedOnFork(
  ctx: ForkContext,
  generated: Generated,
): Promise<{ callsPlanned: number; callsExecuted: number }> {
  const sdk = await loadSdk();
  console.log(
    `[apply-on-fork] running planRoleCalls on ${Object.keys(generated.roles).length} role(s)`,
  );
  const calls = await planRoleCalls({
    generated,
    planApplyRole: sdk.planApplyRole,
    encodeKey: sdk.encodeKey,
    sdkBuilders: { c: sdk.c, processPermissions: sdk.processPermissions },
  });
  console.log(`[apply-on-fork] plan returned ${calls.length} call(s); executing as modifier owner`);
  // The modifier was deployed with owner = ctx.account (the test signer), so
  // management calls (scopeFunction / assignRoles / etc) must come from that
  // signer directly. These calls go to the modifier, not the Safe; the Safe
  // is only the avatar/target. (Production apply wraps these in a Safe TX
  // because the modifier's owner is the Safe; here we own it directly to
  // skip Safe TX Service.)
  for (const [i, c] of calls.entries()) {
    logScopingCall(`call[${String(i)}]`, c.to as Address, c.data as Hex);
    const hash = await ctx.walletClient.sendTransaction({
      chain: mainnet,
      account: ctx.account,
      to: c.to as Address,
      data: c.data as Hex,
      value: 0n,
    });
    const rcpt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status !== 'success') {
      throw new Error(
        `apply call[${String(i)}] reverted on-fork (to=${c.to}, data=${(c.data as string).slice(0, 10)})`,
      );
    }
  }
  return { callsPlanned: calls.length, callsExecuted: calls.length };
}

/**
 * Decode revert data emitted by `execTransactionWithRole` when the inner
 * call fails permission checks. Returns either:
 *  - { kind: 'ConditionViolation', status, statusName }
 *  - { kind: 'OtherError', name }
 *  - { kind: 'Unknown', data }  // not a recognised custom error
 */
export type DecodedRevert =
  | { kind: 'ConditionViolation'; status: number; statusName: string }
  | { kind: 'OtherError'; name: string }
  | { kind: 'Unknown'; data: Hex };

const STATUS_NAMES: readonly string[] = [
  'Ok',
  'DelegateCallNotAllowed',
  'TargetAddressNotAllowed',
  'FunctionNotAllowed',
  'SendNotAllowed',
  'OrViolation',
  'NorViolation',
  'ParameterNotAllowed',
  'ParameterLessThanAllowed',
  'ParameterGreaterThanAllowed',
  'ParameterNotAMatch',
  'NotEveryArrayElementPasses',
  'NoArrayElementPasses',
  'ParameterNotSubsetOfAllowed',
  'BitmaskOverflow',
  'BitmaskNotAllowed',
  'CustomConditionViolation',
  'AllowanceExceeded',
  'CallAllowanceExceeded',
  'EtherAllowanceExceeded',
];

export function statusName(status: number): string {
  return STATUS_NAMES[status] ?? `Unknown(${String(status)})`;
}

export function decodeRolesRevert(data: Hex): DecodedRevert {
  if (data === '0x' || data.length < 10) return { kind: 'Unknown', data };
  try {
    const decoded = decodeErrorResult({ abi: rolesAbi, data });
    if (decoded.errorName === 'ConditionViolation') {
      const args = decoded.args as readonly unknown[];
      const status = Number(args[0]);
      return { kind: 'ConditionViolation', status, statusName: statusName(status) };
    }
    return { kind: 'OtherError', name: decoded.errorName };
  } catch {
    return { kind: 'Unknown', data };
  }
}
