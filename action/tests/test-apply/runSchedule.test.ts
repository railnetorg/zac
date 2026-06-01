import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { ZacError } from '../../errors';
import {
  runSchedule,
  type PendingTx,
  type ScheduleApiKitCtor,
  type ScheduleClient,
} from '../../apply/runSchedule';
import type { SafeDir } from '../../discover';

const SAFE = '0x3333333333333333333333333333333333333333';
const GUARD = '0x9999999999999999999999999999999999999999';
const OWNER_A = '0x1111111111111111111111111111111111111111';
const OWNER_B = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TEST_KEY: `0x${string}` =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Plant the minimum tree `runSchedule` needs to walk:
 *   <tmp>/config.yaml
 *   <tmp>/mainnet/<safe>/safe.yaml
 * with the nested-guard form so the schedule code path runs.
 */
function plantSafeDir(): SafeDir {
  const root = mkdtempSync(join(tmpdir(), 'zac-schedule-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'config.yaml'), 'aliases:\n');
  const dir = join(root, 'mainnet', SAFE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'safe.yaml'),
    `guard:\n  address: "${GUARD}"\n  timelock_delay: 86400\nfallback: ~\nmodules: ~\n`,
  );
  return {
    dirPath: dir,
    network: 'mainnet',
    chainId: 1,
    safeAddress: SAFE as `0x${string}`,
    modifierAddress: undefined,
    sources: [],
    safeConfigPath: join(dir, 'safe.yaml'),
  };
}

function pendingTx(over: Partial<PendingTx> = {}): PendingTx {
  return {
    to: '0x0000000000000000000000000000000000000000',
    value: '0',
    data: '0x',
    operation: 0,
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: 0,
    safeTxHash: '0xc0ffee00000000000000000000000000000000000000000000000000000000aa',
    confirmationsRequired: 2,
    isExecuted: false,
    confirmations: [
      { owner: OWNER_A, signature: '0xaa' + 'aa'.repeat(64) },
      { owner: OWNER_B, signature: '0xbb' + 'bb'.repeat(64) },
    ],
    ...over,
  };
}

function makeApiKitCtor(results: PendingTx[]): ScheduleApiKitCtor {
  return class {
    constructor(_cfg: { chainId: bigint; txServiceUrl?: string; apiKey?: string }) {}
    async getPendingTransactions(_safe: string) {
      return { results };
    }
  } as unknown as ScheduleApiKitCtor;
}

interface RecordedSchedule {
  guard: string;
  safe: string;
  nonce: number;
  signatures: Hex;
}

function makeScheduleClient(opts: {
  liveExecTime?: bigint | ((txHash: string) => bigint);
  scheduleResult?: string;
}): { client: ScheduleClient; broadcasts: RecordedSchedule[] } {
  const broadcasts: RecordedSchedule[] = [];
  const client: ScheduleClient = {
    async readScheduledExecutionTime({ txHash }) {
      if (typeof opts.liveExecTime === 'function') return opts.liveExecTime(txHash);
      return opts.liveExecTime ?? 0n;
    },
    async scheduleTransaction({ guard, safe, nonce, signatures }) {
      broadcasts.push({ guard, safe, nonce, signatures });
      return { txHash: opts.scheduleResult ?? '0xfeed' };
    },
  };
  return { client, broadcasts };
}

describe('runSchedule', () => {
  it('quorum-met & not-yet-scheduled → broadcasts with sorted signatures', async () => {
    const safeDir = plantSafeDir();
    const { client, broadcasts } = makeScheduleClient({});
    const tx = pendingTx({
      // OWNER_B alphabetically AFTER OWNER_A — but feed reversed to force sort.
      confirmations: [
        { owner: OWNER_B, signature: '0xbb' + 'bb'.repeat(64) },
        { owner: OWNER_A, signature: '0xaa' + 'aa'.repeat(64) },
      ],
    });

    process.env['MAINNET_RPC_URL'] = 'http://stub.local';
    const result = await runSchedule({
      safeDir,
      schedulerPrivateKey: TEST_KEY,
      apiKitCtor: makeApiKitCtor([tx]),
      scheduleClient: client,
    });

    expect(result.scheduled).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.guard.toLowerCase()).toBe(GUARD.toLowerCase());
    expect(broadcasts[0]!.nonce).toBe(0);
    // Sigs concatenated in ASCENDING owner-address order: OWNER_A first.
    const sigsHex = broadcasts[0]!.signatures.toLowerCase();
    expect(sigsHex.startsWith('0xaa')).toBe(true);
    expect(sigsHex.indexOf('bb')).toBeGreaterThan(sigsHex.indexOf('aa'));
  });

  it('below threshold → skipped, no broadcast', async () => {
    const safeDir = plantSafeDir();
    const { client, broadcasts } = makeScheduleClient({});
    const tx = pendingTx({
      confirmationsRequired: 3, // only 2 sigs given
    });

    process.env['MAINNET_RPC_URL'] = 'http://stub.local';
    const result = await runSchedule({
      safeDir,
      schedulerPrivateKey: TEST_KEY,
      apiKitCtor: makeApiKitCtor([tx]),
      scheduleClient: client,
    });

    expect(result.scheduled).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('below threshold');
    expect(broadcasts).toHaveLength(0);
  });

  it('already scheduled on-chain → skipped, no broadcast', async () => {
    const safeDir = plantSafeDir();
    const { client, broadcasts } = makeScheduleClient({ liveExecTime: 12345n });
    const tx = pendingTx({});

    process.env['MAINNET_RPC_URL'] = 'http://stub.local';
    const result = await runSchedule({
      safeDir,
      schedulerPrivateKey: TEST_KEY,
      apiKitCtor: makeApiKitCtor([tx]),
      scheduleClient: client,
    });

    expect(result.scheduled).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toBe('already scheduled');
    expect(broadcasts).toHaveLength(0);
  });

  it('safe.yaml without timelock_delay → ZacError(apply)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zac-schedule-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'config.yaml'), 'aliases:\n');
    const dir = join(root, 'mainnet', SAFE);
    mkdirSync(dir, { recursive: true });
    // Bare-address form: install path, but no timelock_delay.
    writeFileSync(
      join(dir, 'safe.yaml'),
      `guard: "${GUARD}"\nfallback: ~\nmodules: ~\n`,
    );
    const safeDir: SafeDir = {
      dirPath: dir,
      network: 'mainnet',
      chainId: 1,
      safeAddress: SAFE as `0x${string}`,
      modifierAddress: undefined,
      sources: [],
      safeConfigPath: join(dir, 'safe.yaml'),
    };
    process.env['MAINNET_RPC_URL'] = 'http://stub.local';

    await expect(
      runSchedule({
        safeDir,
        schedulerPrivateKey: TEST_KEY,
        apiKitCtor: makeApiKitCtor([]),
        scheduleClient: makeScheduleClient({}).client,
      }),
    ).rejects.toThrow(ZacError);
  });

  it('mix: one quorum-met, one below threshold → both reported in order', async () => {
    const safeDir = plantSafeDir();
    const { client, broadcasts } = makeScheduleClient({});

    process.env['MAINNET_RPC_URL'] = 'http://stub.local';
    const result = await runSchedule({
      safeDir,
      schedulerPrivateKey: TEST_KEY,
      apiKitCtor: makeApiKitCtor([
        pendingTx({ nonce: 5, safeTxHash: '0x' + '5'.repeat(64) }),
        pendingTx({
          nonce: 6,
          safeTxHash: '0x' + '6'.repeat(64),
          confirmationsRequired: 3,
        }),
      ]),
      scheduleClient: client,
    });

    expect(result.scheduled).toHaveLength(1);
    expect(result.scheduled[0]!.nonce).toBe(5);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.nonce).toBe(6);
    expect(broadcasts).toHaveLength(1);
  });
});
