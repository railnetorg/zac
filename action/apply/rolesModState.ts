import { createPublicClient, http, parseEventLogs, type Abi, type Log } from 'viem';
import { ZacError } from '../errors';

/**
 * Current state of a Roles v2 modifier, rebuilt from its own event log.
 *
 * Gnosis Guild retired the public Roles subgraph that `zodiac-roles-sdk@3`
 * read current state from (`fetchRolesMod`), so `planApply` can no longer
 * diff on its own. This module rebuilds the exact shape the SDK's
 * `callsPlannedForApply` diffs against — `RolesModifier` from
 * `zodiac-roles-deployments` — by replaying every event the modifier ever
 * emitted, fetched over plain JSON-RPC (`eth_getLogs`). It mirrors contract
 * storage, not the subgraph's presentation: a target revoked with
 * `revokeTarget` keeps its scoped functions (they stay in storage and come
 * back to life on the next `scopeTarget`), so the diff plans their
 * `revokeFunction` explicitly.
 *
 * Addresses, role keys and selectors are lowercased: the SDK compares target
 * addresses and selectors with `===` against its own lowercased desired state.
 */

export type Hex = `0x${string}`;

/** Numeric enums, as `zodiac-roles-sdk` (via `zodiac-roles-deployments`) stores them. */
export const CLEARANCE = { None: 0, Target: 1, Function: 2 } as const;
export const EXECUTION_OPTIONS = { None: 0, Send: 1, DelegateCall: 2, Both: 3 } as const;

export interface ConditionNode {
  paramType: number;
  operator: number;
  compValue?: Hex;
  children?: ConditionNode[];
}

/** One row of the `ConditionFlat[]` a `ScopeFunction` event carries. */
export interface ConditionFlat {
  parent: number;
  paramType: number;
  operator: number;
  compValue: Hex;
}

export interface FunctionState {
  selector: Hex;
  executionOptions: number;
  wildcarded: boolean;
  condition?: ConditionNode;
}

export interface TargetState {
  address: Hex;
  clearance: number;
  executionOptions: number;
  functions: FunctionState[];
}

export interface RoleState {
  key: Hex;
  members: Hex[];
  targets: TargetState[];
  /** Annotations live off-chain (Poster posts); zac never manages them. */
  annotations: never[];
  lastUpdate: number;
}

export interface AllowanceState {
  key: Hex;
  refill: bigint;
  maxRefill: bigint;
  period: bigint;
  balance: bigint;
  timestamp: bigint;
}

export interface RolesModState {
  address: Hex;
  owner: Hex;
  avatar: Hex;
  target: Hex;
  roles: RoleState[];
  allowances: AllowanceState[];
  multiSendAddresses: Hex[];
}

/** A decoded modifier event — what `viem.parseEventLogs` yields, narrowed to what the reducer reads. */
export interface DecodedRolesEvent {
  eventName: string;
  args: Record<string, unknown>;
}

const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';
/** `MultiSend.multiSend(bytes)` */
const MULTISEND_SELECTOR = '0x8d80ff0a';
/** The two MultiSendUnwrapper deployments `zodiac-roles-deployments` recognizes. */
const MULTISEND_UNWRAPPERS = new Set<string>([
  '0x93b7fcbc63ed8a3a24b59e1c3e6649d50b7427c0',
  '0xb4cd4bb764c089f20da18700ce8bc5e49f369efd',
]);

function fail(message: string): never {
  throw new ZacError({ phase: 'apply', message });
}

function hexArg(args: Record<string, unknown>, name: string, eventName: string): Hex {
  const v = args[name];
  if (typeof v !== 'string' || !v.startsWith('0x')) {
    fail(`event ${eventName}: expected hex string for '${name}', got ${JSON.stringify(v)}`);
  }
  return v.toLowerCase() as Hex;
}

function numArg(args: Record<string, unknown>, name: string, eventName: string): number {
  const v = args[name];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  fail(`event ${eventName}: expected number for '${name}', got ${JSON.stringify(v)}`);
}

function bigArg(args: Record<string, unknown>, name: string, eventName: string): bigint {
  const v = args[name];
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  fail(`event ${eventName}: expected bigint for '${name}', got ${JSON.stringify(v)}`);
}

function arrayArg(args: Record<string, unknown>, name: string, eventName: string): unknown[] {
  const v = args[name];
  if (!Array.isArray(v)) {
    fail(`event ${eventName}: expected array for '${name}', got ${JSON.stringify(v)}`);
  }
  return v;
}

function toConditionFlat(row: unknown, eventName: string): ConditionFlat {
  if (typeof row !== 'object' || row === null) {
    fail(`event ${eventName}: malformed ConditionFlat row ${JSON.stringify(row)}`);
  }
  const r = row as Record<string, unknown>;
  const compValue = r['compValue'];
  return {
    parent: numArg(r, 'parent', eventName),
    paramType: numArg(r, 'paramType', eventName),
    operator: numArg(r, 'operator', eventName),
    compValue:
      typeof compValue === 'string' && compValue.startsWith('0x') ? (compValue as Hex) : '0x',
  };
}

/**
 * Inverse of the SDK's `flattenCondition` (breadth-first, parent index per
 * row, root's parent is itself). Empty `0x` compValues become `undefined` and
 * leaves carry no `children` key — exactly what `zodiac-roles-deployments`'
 * `cleanCondition` produced from the subgraph, so the SDK's
 * `normalizeCondition` + `conditionId` see the same tree either way.
 */
export function unflattenCondition(flat: readonly ConditionFlat[]): ConditionNode {
  const first = flat[0];
  if (first === undefined) fail('ScopeFunction carried an empty condition set');
  const nodes: ConditionNode[] = flat.map((row) => {
    const node: ConditionNode = { paramType: row.paramType, operator: row.operator };
    if (row.compValue !== '0x') node.compValue = row.compValue.toLowerCase() as Hex;
    return node;
  });
  for (let i = 1; i < flat.length; i++) {
    const row = flat[i]!;
    const node = nodes[i]!;
    const parent = nodes[row.parent];
    if (parent === undefined || row.parent >= i) {
      fail(`ScopeFunction condition row ${i} points at invalid parent ${row.parent}`);
    }
    (parent.children ??= []).push(node);
  }
  return nodes[0]!;
}

interface MutableFunction {
  selector: Hex;
  executionOptions: number;
  wildcarded: boolean;
  condition?: ConditionNode;
}

interface MutableTarget {
  address: Hex;
  clearance: number;
  executionOptions: number;
  functions: Map<Hex, MutableFunction>;
}

interface MutableRole {
  key: Hex;
  members: Set<Hex>;
  targets: Map<Hex, MutableTarget>;
}

/**
 * Replay decoded modifier events (in emission order) into the SDK's
 * `RolesModifier` shape. Pure — the fetch lives in `fetchRolesModState`.
 */
export function reduceRolesModState(
  address: Hex,
  events: readonly DecodedRolesEvent[],
): RolesModState {
  let owner: Hex = ZERO_ADDRESS;
  let avatar: Hex = ZERO_ADDRESS;
  let target: Hex = ZERO_ADDRESS;
  const roles = new Map<Hex, MutableRole>();
  const allowances = new Map<Hex, AllowanceState>();
  /** `${to}:${selector}` → adapter */
  const unwrapAdapters = new Map<string, { to: Hex; selector: Hex; adapter: Hex }>();

  const role = (key: Hex): MutableRole => {
    let r = roles.get(key);
    if (r === undefined) {
      r = { key, members: new Set(), targets: new Map() };
      roles.set(key, r);
    }
    return r;
  };
  const targetOf = (r: MutableRole, addr: Hex): MutableTarget => {
    let t = r.targets.get(addr);
    if (t === undefined) {
      t = {
        address: addr,
        clearance: CLEARANCE.None,
        executionOptions: EXECUTION_OPTIONS.None,
        functions: new Map(),
      };
      r.targets.set(addr, t);
    }
    return t;
  };

  for (const ev of events) {
    const { eventName: name, args } = ev;
    switch (name) {
      case 'RolesModSetup':
        owner = hexArg(args, 'owner', name);
        avatar = hexArg(args, 'avatar', name);
        target = hexArg(args, 'target', name);
        break;
      case 'OwnershipTransferred':
        owner = hexArg(args, 'newOwner', name);
        break;
      case 'AvatarSet':
        avatar = hexArg(args, 'newAvatar', name);
        break;
      case 'TargetSet':
        target = hexArg(args, 'newTarget', name);
        break;
      case 'AssignRoles': {
        const module = hexArg(args, 'module', name);
        const keys = arrayArg(args, 'roleKeys', name);
        const memberOf = arrayArg(args, 'memberOf', name);
        if (keys.length !== memberOf.length) {
          fail(`event ${name}: roleKeys/memberOf length mismatch`);
        }
        keys.forEach((k, i) => {
          const key = hexArg({ k }, 'k', name);
          const r = role(key);
          if (memberOf[i] === true) r.members.add(module);
          else r.members.delete(module);
        });
        break;
      }
      case 'AllowTarget': {
        const t = targetOf(
          role(hexArg(args, 'roleKey', name)),
          hexArg(args, 'targetAddress', name),
        );
        t.clearance = CLEARANCE.Target;
        t.executionOptions = numArg(args, 'options', name);
        break;
      }
      case 'ScopeTarget': {
        const t = targetOf(
          role(hexArg(args, 'roleKey', name)),
          hexArg(args, 'targetAddress', name),
        );
        t.clearance = CLEARANCE.Function;
        t.executionOptions = EXECUTION_OPTIONS.None;
        break;
      }
      case 'RevokeTarget': {
        const t = targetOf(
          role(hexArg(args, 'roleKey', name)),
          hexArg(args, 'targetAddress', name),
        );
        t.clearance = CLEARANCE.None;
        t.executionOptions = EXECUTION_OPTIONS.None;
        break;
      }
      case 'AllowFunction': {
        const t = targetOf(
          role(hexArg(args, 'roleKey', name)),
          hexArg(args, 'targetAddress', name),
        );
        const selector = hexArg(args, 'selector', name);
        t.functions.set(selector, {
          selector,
          executionOptions: numArg(args, 'options', name),
          wildcarded: true,
        });
        break;
      }
      case 'ScopeFunction': {
        const t = targetOf(
          role(hexArg(args, 'roleKey', name)),
          hexArg(args, 'targetAddress', name),
        );
        const selector = hexArg(args, 'selector', name);
        const flat = arrayArg(args, 'conditions', name).map((row) => toConditionFlat(row, name));
        t.functions.set(selector, {
          selector,
          executionOptions: numArg(args, 'options', name),
          wildcarded: false,
          condition: unflattenCondition(flat),
        });
        break;
      }
      case 'RevokeFunction': {
        const t = targetOf(
          role(hexArg(args, 'roleKey', name)),
          hexArg(args, 'targetAddress', name),
        );
        t.functions.delete(hexArg(args, 'selector', name));
        break;
      }
      case 'SetAllowance': {
        const key = hexArg(args, 'allowanceKey', name);
        allowances.set(key, {
          key,
          balance: bigArg(args, 'balance', name),
          maxRefill: bigArg(args, 'maxRefill', name),
          refill: bigArg(args, 'refill', name),
          period: bigArg(args, 'period', name),
          timestamp: bigArg(args, 'timestamp', name),
        });
        break;
      }
      case 'ConsumeAllowance': {
        const key = hexArg(args, 'allowanceKey', name);
        const a = allowances.get(key);
        if (a !== undefined) a.balance = bigArg(args, 'newBalance', name);
        break;
      }
      case 'SetUnwrapAdapter': {
        const to = hexArg(args, 'to', name);
        const selector = hexArg(args, 'selector', name);
        const adapter = hexArg(args, 'adapter', name);
        const id = `${to}:${selector}`;
        if (adapter === ZERO_ADDRESS) unwrapAdapters.delete(id);
        else unwrapAdapters.set(id, { to, selector, adapter });
        break;
      }
      default:
        // EnabledModule / DisabledModule / SetDefaultRole / HashExecuted /
        // ExecutionFromModule* / Initialized: not part of the diffed state.
        break;
    }
  }

  const multiSendAddresses = Array.from(unwrapAdapters.values())
    .filter((a) => a.selector === MULTISEND_SELECTOR && MULTISEND_UNWRAPPERS.has(a.adapter))
    .map((a) => a.to);

  return {
    address: address.toLowerCase() as Hex,
    owner,
    avatar,
    target,
    roles: Array.from(roles.values()).map((r) => ({
      key: r.key,
      members: Array.from(r.members),
      targets: Array.from(r.targets.values()).map((t) => ({
        address: t.address,
        clearance: t.clearance,
        executionOptions: t.executionOptions,
        functions: Array.from(t.functions.values()).map((f) => {
          const out: FunctionState = {
            selector: f.selector,
            executionOptions: f.executionOptions,
            wildcarded: f.wildcarded,
          };
          if (f.condition !== undefined) out.condition = f.condition;
          return out;
        }),
      })),
      annotations: [],
      lastUpdate: 0,
    })),
    allowances: Array.from(allowances.values()),
    multiSendAddresses,
  };
}

/** The slice of a viem `PublicClient` the fetch needs — inject a fake in tests. */
export interface LogsClient {
  getBlockNumber(): Promise<bigint>;
  getCode(args: { address: Hex; blockNumber: bigint }): Promise<Hex | undefined>;
  getLogs(args: { address: Hex; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
}

/** Retry knobs — injectable so unit tests never sleep. */
export interface RetryOpts {
  /** Attempts per request before a transient error is surfaced. Default 6. */
  maxAttempts?: number;
  /** First back-off delay; doubles each attempt, capped at 30s. Default 1s. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchRolesModStateOpts {
  rpcUrl: string;
  address: Hex;
  /** Roles v2 ABI used to decode the logs. Default: `rolesAbi` from `zodiac-roles-sdk`. */
  abi?: Abi;
  /** Inject for testability. Default: a viem `PublicClient` over `rpcUrl`. */
  client?: LogsClient;
  /** Progress / fallback notes (stderr in the CLI). */
  log?: (line: string) => void;
  retry?: RetryOpts;
}

const DEFAULT_RPC_TIMEOUT_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The provider's own words for the failure, without viem's request dump. */
export function rpcErrorDetails(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { details?: unknown; shortMessage?: unknown; message?: unknown };
    for (const v of [e.details, e.shortMessage, e.message]) {
      if (typeof v === 'string' && v.trim() !== '') return v.split('\n')[0]!.trim();
    }
  }
  return String(err);
}

/**
 * Rate limits, timeouts and gateway errors are worth waiting out; anything
 * else (range / result-size caps, bad params) is reported as-is so the
 * caller can shrink the request instead.
 */
export function isTransientRpcError(err: unknown): boolean {
  const status =
    typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined;
  if (typeof status === 'number' && (status === 408 || status === 429 || status >= 500))
    return true;
  const text = [rpcErrorDetails(err), err instanceof Error ? err.message : ''].join(' ');
  return /rate.?limit|too many requests|timeout|timed out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|temporarily|\b50[234]\b|\b429\b/i.test(
    text,
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts,
  log?: (line: string) => void,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const base = opts.baseDelayMs ?? 1_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientRpcError(err) || attempt >= maxAttempts) throw err;
      const delay = Math.min(base * 2 ** (attempt - 1), 30_000);
      log?.(`rpc: ${rpcErrorDetails(err)} — retrying in ${delay}ms (${attempt}/${maxAttempts})\n`);
      await sleep(delay);
    }
  }
}

function viemClient(rpcUrl: string): LogsClient {
  const pc = createPublicClient({ transport: http(rpcUrl, { timeout: DEFAULT_RPC_TIMEOUT_MS }) });
  return {
    getBlockNumber: () => pc.getBlockNumber(),
    getCode: (a) => pc.getCode(a),
    getLogs: (a) => pc.getLogs(a),
  };
}

function hasCode(code: Hex | undefined): boolean {
  return code !== undefined && code !== '0x';
}

/**
 * Lowest block at which the modifier has code (binary search on
 * `eth_getCode`, ~25 calls). Needs an archive-capable RPC; on one that
 * refuses historical `eth_getCode` we fall back to scanning from genesis and
 * say so, which is slow but still correct.
 */
export async function findCreationBlock(
  client: LogsClient,
  address: Hex,
  latest: bigint,
  log?: (line: string) => void,
  retry: RetryOpts = {},
): Promise<bigint> {
  let lo = 0n;
  let hi = latest;
  try {
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const code = await withRetry(() => client.getCode({ address, blockNumber: mid }), retry, log);
      if (hasCode(code)) hi = mid;
      else lo = mid + 1n;
    }
    return lo;
  } catch (err) {
    log?.(
      `WARN: historical eth_getCode failed (${rpcErrorDetails(err)}); scanning ${address} logs from genesis — use an archive RPC to avoid this\n`,
    );
    return 0n;
  }
}

/**
 * `eth_getLogs` for one address over [from, to], adapting the chunk size to
 * whatever the provider tolerates: start with the whole range, halve on a
 * cap error, keep the size that worked. One call on Alchemy-class
 * providers, ~10k-block chunks on free tiers that cap the range. Rate
 * limits and other transient failures are waited out at the same size
 * (`withRetry`) rather than mistaken for a cap.
 */
export async function collectLogs(
  client: LogsClient,
  address: Hex,
  from: bigint,
  to: bigint,
  log?: (line: string) => void,
  retry: RetryOpts = {},
): Promise<Log[]> {
  const out: Log[] = [];
  let span = to - from + 1n;
  let cursor = from;
  while (cursor <= to) {
    const end = cursor + span - 1n < to ? cursor + span - 1n : to;
    try {
      const logs = await withRetry(
        () => client.getLogs({ address, fromBlock: cursor, toBlock: end }),
        retry,
        log,
      );
      out.push(...logs);
      cursor = end + 1n;
    } catch (err) {
      const reason = rpcErrorDetails(err);
      if (span <= 1n || isTransientRpcError(err)) {
        fail(`eth_getLogs failed for ${address} at blocks ${cursor}-${end}: ${reason}`);
      }
      span = span / 2n;
      log?.(`eth_getLogs ${cursor}-${end} refused (${reason}); retrying in ${span}-block chunks\n`);
    }
  }
  return out;
}

function logOrder(a: Log, b: Log): number {
  const ab = a.blockNumber ?? 0n;
  const bb = b.blockNumber ?? 0n;
  if (ab !== bb) return ab < bb ? -1 : 1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/** Rebuild a modifier's current state from its full event log over JSON-RPC. */
export async function fetchRolesModState(opts: FetchRolesModStateOpts): Promise<RolesModState> {
  const address = opts.address.toLowerCase() as Hex;
  const client = opts.client ?? viemClient(opts.rpcUrl);
  const abi = opts.abi ?? ((await import('zodiac-roles-sdk')).rolesAbi as unknown as Abi);

  const retry = opts.retry ?? {};
  const latest = await withRetry(() => client.getBlockNumber(), retry, opts.log);
  const codeNow = await withRetry(
    () => client.getCode({ address, blockNumber: latest }),
    retry,
    opts.log,
  );
  if (!hasCode(codeNow)) {
    fail(
      `no contract code at Roles modifier ${address} (block ${latest}) — wrong address or wrong network?`,
    );
  }
  const from = await findCreationBlock(client, address, latest, opts.log, retry);
  const logs = (await collectLogs(client, address, from, latest, opts.log, retry)).sort(logOrder);
  const decoded = parseEventLogs({ abi, logs, strict: false }) as unknown as {
    eventName: string;
    args: unknown;
  }[];
  const events: DecodedRolesEvent[] = decoded.map((d) => ({
    eventName: d.eventName,
    args: (d.args ?? {}) as Record<string, unknown>,
  }));
  opts.log?.(`rebuilt ${address} state from ${events.length} events (blocks ${from}-${latest})\n`);
  return reduceRolesModState(address, events);
}
