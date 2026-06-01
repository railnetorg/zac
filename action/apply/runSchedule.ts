import { dirname } from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { SafeDir } from '../discover';
import { ZacError } from '../errors';
import { findConfig } from '../load/findConfig';
import { loadAllAliases } from '../load/loadAllAliases';
import { parseAndValidateSafeYaml } from '../validate/safeConfigSchema';
import { resolveRpcUrl } from './rpc';
import { safeServiceUrlForChain } from './safeServiceUrl';

/**
 * Subset of @safe-global/api-kit's `SafeMultisigTransactionResponse` that
 * `runSchedule` reads. Other fields exist on the live response — kept
 * minimal so a stubbed apiKit only has to return what we use.
 */
export interface PendingTx {
  to: string;
  value: string;
  data: string | null;
  operation: number;
  safeTxGas: string | number;
  baseGas: string | number;
  gasPrice: string | number;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
  safeTxHash: string;
  confirmationsRequired: number;
  isExecuted: boolean;
  confirmations: Array<{ owner: string; signature: string }> | null;
}

interface PendingTxList {
  results: PendingTx[];
}

/** Constructor shape we need from @safe-global/api-kit (extended for fetch). */
export type ScheduleApiKitCtor = new (config: {
  chainId: bigint;
  txServiceUrl?: string;
  apiKey?: string;
}) => {
  getPendingTransactions(safeAddress: string): Promise<PendingTxList>;
};

/**
 * On-chain interface needed by `runSchedule` — split out so tests can stub
 * both calls without spinning up an anvil instance.
 */
export interface ScheduleClient {
  /** Returns 0n when the tx has never been scheduled for this safe. */
  readScheduledExecutionTime(args: {
    guard: string;
    safe: string;
    txHash: string;
  }): Promise<bigint>;
  /** Broadcasts `guard.scheduleTransaction(...)` and returns the L1 tx hash. */
  scheduleTransaction(args: {
    guard: string;
    safe: string;
    nonce: number;
    params: ScheduleParams;
    signatures: Hex;
  }): Promise<{ txHash: string }>;
}

export interface ScheduleParams {
  to: string;
  value: bigint;
  data: Hex;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
}

export interface RunScheduleOpts {
  safeDir: SafeDir;
  schedulerPrivateKey: `0x${string}`;
  /** CLI `--rpc-url` override; otherwise resolved per-chain via env. */
  rpcUrl?: string;
  /** SAFE_API_KEY equivalent — forwarded to api-kit. */
  apiKey?: string;
  /** Override the Safe Transaction Service URL (otherwise looked up per chain). */
  txServiceUrl?: string;
  /** Injected for testability. */
  apiKitCtor?: ScheduleApiKitCtor;
  /** Injected for testability. */
  scheduleClient?: ScheduleClient;
}

export interface ScheduleOutcome {
  scheduled: Array<{ nonce: number; safeTxHash: string; txHash: string }>;
  /** Per-tx skip reasons, ordered by source position in the API list. */
  skipped: Array<{ nonce: number; safeTxHash: string; reason: string }>;
}

const TIMELOCK_GUARD_ABI = [
  {
    type: 'function',
    name: 'scheduleTransaction',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_safe', type: 'address' },
      { name: '_nonce', type: 'uint256' },
      {
        name: '_params',
        type: 'tuple',
        components: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' },
          { name: 'baseGas', type: 'uint256' },
          { name: 'gasPrice', type: 'uint256' },
          { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' },
        ],
      },
      { name: '_signatures', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'scheduledTransaction',
    stateMutability: 'view',
    inputs: [
      { name: '_safe', type: 'address' },
      { name: '_txHash', type: 'bytes32' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'txHash', type: 'bytes32' },
          { name: 'executionTime', type: 'uint256' },
          { name: 'state', type: 'uint8' },
          {
            name: 'params',
            type: 'tuple',
            components: [
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
              { name: 'operation', type: 'uint8' },
              { name: 'safeTxGas', type: 'uint256' },
              { name: 'baseGas', type: 'uint256' },
              { name: 'gasPrice', type: 'uint256' },
              { name: 'gasToken', type: 'address' },
              { name: 'refundReceiver', type: 'address' },
            ],
          },
          { name: 'nonce', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

/**
 * For one safe-dir: read `safe.yaml`, require nested guard with
 * `timelock_delay`, fetch pending proposals from Safe Transaction Service,
 * and broadcast `scheduleTransaction` on every proposal that has reached
 * its confirmation threshold and is not already scheduled on-chain.
 *
 * Order of operations is preserved from the Safe TX service response
 * (which is nonce-ascending by default), so callers can stream the
 * outcome and watch them appear in order.
 */
export async function runSchedule(opts: RunScheduleOpts): Promise<ScheduleOutcome> {
  if (opts.safeDir.safeConfigPath === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: `safe.yaml missing in ${opts.safeDir.dirPath}; \`zac schedule\` requires a safe.yaml with a timelock guard configured`,
    });
  }

  // Re-parse safe.yaml: we need the rendered guard address + delay. Aliases
  // resolve relative to the discovered root config.yaml — same path as
  // `runPlanForSafeDir`.
  const configPath = findConfig({ startDir: opts.safeDir.dirPath });
  const aliases = loadAllAliases({ configPath, network: opts.safeDir.network });
  const safeYaml = parseAndValidateSafeYaml({
    path: opts.safeDir.safeConfigPath,
    aliases: aliases.merged,
    configDir: dirname(configPath),
    network: opts.safeDir.network,
  });

  if (safeYaml.guard === null || safeYaml.guard.timelockDelay === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: `safe.yaml: \`schedule\` requires guard with timelock_delay (object form)`,
      sourceLocation: { file: opts.safeDir.safeConfigPath },
    });
  }
  const guard = safeYaml.guard.address;

  const rpcUrl = resolveRpcUrl({
    chainId: opts.safeDir.chainId,
    ...(opts.rpcUrl !== undefined ? { overrideUrl: opts.rpcUrl } : {}),
  });

  const txServiceUrl = opts.txServiceUrl ?? safeServiceUrlForChain(opts.safeDir.chainId);
  if (txServiceUrl === null && opts.apiKey === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: `no Safe Transaction Service URL for chainId ${opts.safeDir.chainId} and no SAFE_API_KEY set`,
    });
  }

  const ApiKitClass = opts.apiKitCtor ?? (await loadApiKitCtor());
  const apiKitConfig: { chainId: bigint; txServiceUrl?: string; apiKey?: string } = {
    chainId: BigInt(opts.safeDir.chainId),
  };
  if (txServiceUrl !== null) apiKitConfig.txServiceUrl = txServiceUrl;
  if (opts.apiKey !== undefined) apiKitConfig.apiKey = opts.apiKey;
  const apiKit = new ApiKitClass(apiKitConfig);

  let pending: PendingTxList;
  try {
    pending = await apiKit.getPendingTransactions(opts.safeDir.safeAddress);
  } catch (err) {
    throw new ZacError({
      phase: 'apply',
      message: `Safe Transaction Service getPendingTransactions failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const client = opts.scheduleClient ?? makeViemScheduleClient(rpcUrl, opts.schedulerPrivateKey);

  const scheduled: ScheduleOutcome['scheduled'] = [];
  const skipped: ScheduleOutcome['skipped'] = [];

  for (const tx of pending.results) {
    if (tx.isExecuted) {
      skipped.push({ nonce: tx.nonce, safeTxHash: tx.safeTxHash, reason: 'already executed' });
      continue;
    }
    const confs = tx.confirmations ?? [];
    if (confs.length < tx.confirmationsRequired) {
      skipped.push({
        nonce: tx.nonce,
        safeTxHash: tx.safeTxHash,
        reason: `below threshold (${confs.length}/${tx.confirmationsRequired})`,
      });
      continue;
    }

    const liveExecTime = await client.readScheduledExecutionTime({
      guard,
      safe: opts.safeDir.safeAddress,
      txHash: tx.safeTxHash,
    });
    if (liveExecTime !== 0n) {
      skipped.push({ nonce: tx.nonce, safeTxHash: tx.safeTxHash, reason: 'already scheduled' });
      continue;
    }

    const signatures = packSortedSignatures(confs);
    const params: ScheduleParams = {
      to: tx.to,
      value: BigInt(tx.value),
      data: ((tx.data ?? '0x') as Hex),
      operation: tx.operation,
      safeTxGas: BigInt(tx.safeTxGas),
      baseGas: BigInt(tx.baseGas),
      gasPrice: BigInt(tx.gasPrice),
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
    };

    let txHash: string;
    try {
      ({ txHash } = await client.scheduleTransaction({
        guard,
        safe: opts.safeDir.safeAddress,
        nonce: tx.nonce,
        params,
        signatures,
      }));
    } catch (err) {
      throw new ZacError({
        phase: 'apply',
        message: `scheduleTransaction broadcast failed for nonce=${tx.nonce} safeTxHash=${tx.safeTxHash}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    scheduled.push({ nonce: tx.nonce, safeTxHash: tx.safeTxHash, txHash });
  }

  return { scheduled, skipped };
}

/**
 * Safe verifies concatenated signatures via `checkSignatures`, which expects
 * the per-owner signatures laid out in ascending owner-address order.
 * api-kit returns confirmations in insertion order from Safe Tx Service, so
 * we sort here at the call boundary.
 */
function packSortedSignatures(
  confs: Array<{ owner: string; signature: string }>,
): Hex {
  const sorted = [...confs].sort((a, b) => {
    const la = a.owner.toLowerCase();
    const lb = b.owner.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  });
  const concat = sorted.map((c) => c.signature.replace(/^0x/, '')).join('');
  return (`0x${concat}` as Hex);
}

function makeViemScheduleClient(rpcUrl: string, privateKey: `0x${string}`): ScheduleClient {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  return {
    async readScheduledExecutionTime({ guard, safe, txHash }) {
      try {
        const result = (await publicClient.readContract({
          address: guard as `0x${string}`,
          abi: TIMELOCK_GUARD_ABI,
          functionName: 'scheduledTransaction',
          args: [safe as `0x${string}`, txHash as `0x${string}`],
        })) as { executionTime: bigint };
        return result.executionTime;
      } catch {
        // Reverts on un-configured safes — treat as "not scheduled" so we
        // still try to schedule (the on-chain guard will revert with its
        // own diagnostic if it really can't).
        return 0n;
      }
    },
    async scheduleTransaction({ guard, safe, nonce, params, signatures }) {
      const data = encodeFunctionData({
        abi: TIMELOCK_GUARD_ABI,
        functionName: 'scheduleTransaction',
        args: [
          safe as `0x${string}`,
          BigInt(nonce),
          {
            ...params,
            to: params.to as `0x${string}`,
            gasToken: params.gasToken as `0x${string}`,
            refundReceiver: params.refundReceiver as `0x${string}`,
          },
          signatures,
        ],
      });
      const txHash = await walletClient.sendTransaction({
        to: guard as `0x${string}`,
        data,
        chain: null,
      });
      return { txHash };
    },
  };
}

async function loadApiKitCtor(): Promise<ScheduleApiKitCtor> {
  const mod = (await import('@safe-global/api-kit')) as unknown as {
    default: ScheduleApiKitCtor;
  };
  return mod.default;
}
