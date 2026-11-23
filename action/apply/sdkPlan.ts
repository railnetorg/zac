import type { PlanApplyFn } from './planSafeDirCalls';
import type { PlanApplyRoleFn } from './planRoleCalls';
import { fetchRolesModState, type Hex, type RolesModState } from './rolesModState';

/**
 * Log-backed replacements for `zodiac-roles-sdk`'s `planApply` /
 * `planApplyRole`. Those two read the modifier's current state from the
 * retired Roles subgraph; these rebuild it from the modifier's event log
 * (`fetchRolesModState`) and hand it to the SDK's pure, exported diff +
 * encode primitives, which is all `planApply` did after the fetch — minus the
 * subgraph-backed license lookup, which has no replacement.
 */

/** The three pure SDK exports the plan needs. */
export interface SdkDiffFns {
  callsPlannedForApply: (prev: unknown, next: unknown) => unknown[];
  callsPlannedForApplyRole: (prev: unknown, next: unknown) => unknown[];
  encodeCalls: (calls: unknown[], rolesMod: Hex) => { to: Hex; data: Hex }[];
}

export type FetchStateFn = (opts: {
  rpcUrl: string;
  address: Hex;
  log?: (line: string) => void;
}) => Promise<RolesModState>;

export interface LogBackedPlanOpts {
  rpcUrl: string;
  /** Inject for testability. Default: the real `zodiac-roles-sdk` exports. */
  sdk?: SdkDiffFns;
  /** Inject for testability. Default: `fetchRolesModState`. */
  fetchState?: FetchStateFn;
  log?: (line: string) => void;
}

async function loadSdkDiffFns(): Promise<SdkDiffFns> {
  const mod = (await import('zodiac-roles-sdk')) as unknown as SdkDiffFns;
  return {
    callsPlannedForApply: mod.callsPlannedForApply,
    callsPlannedForApplyRole: mod.callsPlannedForApplyRole,
    encodeCalls: mod.encodeCalls,
  };
}

function fetchArgs(opts: LogBackedPlanOpts, address: Hex): Parameters<FetchStateFn>[0] {
  const args: Parameters<FetchStateFn>[0] = { rpcUrl: opts.rpcUrl, address };
  if (opts.log !== undefined) args.log = opts.log;
  return args;
}

/**
 * `planApply` over the whole modifier: `desired.roles` is the full set, so
 * roles are replaced wholesale and allowances carried over untouched — the
 * same merge the SDK's `spreadPartial` performs for an array `roles` and an
 * absent `allowances`.
 */
export function makePlanApply(opts: LogBackedPlanOpts): PlanApplyFn {
  return async (desired, meta) => {
    const sdk = opts.sdk ?? (await loadSdkDiffFns());
    const fetchState = opts.fetchState ?? fetchRolesModState;
    const prev = await fetchState(fetchArgs(opts, meta.address));
    const next = { roles: desired.roles, allowances: prev.allowances };
    const calls = sdk.callsPlannedForApply(prev, next);
    return sdk.encodeCalls(calls, meta.address);
  };
}

/** The SDK's `clean`: drop null/undefined fields so they don't overwrite `prev`'s. */
function clean<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<T>;
}

/**
 * `planApplyRole` for one role: the desired fragment is spread over the
 * role's current state (or an empty role when it does not exist yet), as the
 * SDK does, and diffed with `callsPlannedForApplyRole`.
 */
export function makePlanApplyRole(opts: LogBackedPlanOpts): PlanApplyRoleFn {
  return async (desired, meta) => {
    const sdk = opts.sdk ?? (await loadSdkDiffFns());
    const fetchState = opts.fetchState ?? fetchRolesModState;
    const state = await fetchState(fetchArgs(opts, meta.address));
    const key = desired.key.toLowerCase();
    const prev = state.roles.find((r) => r.key.toLowerCase() === key);
    const base = prev ?? { members: [], targets: [], annotations: [], lastUpdate: 0 };
    const next = { ...base, ...clean(desired) };
    const calls = sdk.callsPlannedForApplyRole(prev, next);
    return sdk.encodeCalls(calls, meta.address);
  };
}
