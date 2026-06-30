import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { buildProgram } from '../../cli';
import {
  computeNestedSafeMessageDetails,
  computeSafeDomainSeparator,
} from '../../apply/nestedSafeHash';
import { computeSafeTxMessageHash } from '../../apply/safeApi';
import type { SafeTxData } from '../../apply/planSchema';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-cli-nested-submit-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE = '0x3333333333333333333333333333333333333333';
const CHILD_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// Known safeTxHash returned by the stubbed Safe.getTransactionHash — this is
// the parent's `safeTxHash` the nested signing hash wraps.
const KNOWN_SAFE_TX_HASH = '0x' + 'cd'.repeat(32);
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Mirror of the SafeTxData the protocol-kit `createTransaction` stub returns
// (kept in sync with the `vi.mock` factory below — the factory is hoisted and
// cannot reference module-scope consts, so the shape is duplicated here for
// the parent `messageHash` cross-check).
const STUB_TX_DATA: SafeTxData = {
  baseGas: '0',
  data: '0xbundled',
  gasPrice: '0',
  gasToken: '0x0000000000000000000000000000000000000000',
  nonce: 5,
  operation: 0,
  refundReceiver: '0x0000000000000000000000000000000000000000',
  safeTxGas: '0',
  to: SAFE,
  value: '0',
};
const PARENT_DOMAIN_HASH = computeSafeDomainSeparator(1, SAFE);
const PARENT_MESSAGE_HASH = computeSafeTxMessageHash(STUB_TX_DATA);

async function captureStdout(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const outStream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      outChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  const errStream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      errChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  process.stdout.write = ((chunk: Buffer | string, enc?: unknown, cb?: unknown): boolean => {
    outStream.write(chunk);
    if (typeof cb === 'function') (cb as () => void)();
    else if (typeof enc === 'function') (enc as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: Buffer | string, enc?: unknown, cb?: unknown): boolean => {
    errStream.write(chunk);
    if (typeof cb === 'function') (cb as () => void)();
    else if (typeof enc === 'function') (enc as () => void)();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return {
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
  };
}

// Stub the Safe SDK so the built parent safeTxHash is the KNOWN value and
// no real network call is made.
vi.mock('@safe-global/protocol-kit', () => ({
  default: {
    init: async () => ({
      createTransaction: async () => ({
        data: {
          baseGas: '0',
          data: '0xbundled',
          gasPrice: '0',
          gasToken: '0x0000000000000000000000000000000000000000',
          nonce: 5,
          operation: 0,
          refundReceiver: '0x0000000000000000000000000000000000000000',
          safeTxGas: '0',
          to: '0x3333333333333333333333333333333333333333',
          value: '0',
        },
      }),
      getTransactionHash: async () => KNOWN_SAFE_TX_HASH,
      signHash: async () => ({ data: '0xsig' }),
    }),
  },
}));

// Stub the Safe Transaction Service client — propose is a no-op.
vi.mock('@safe-global/api-kit', () => ({
  default: class {
    async proposeTransaction(): Promise<void> {
      // no-op
    }
  },
}));

function writePlan(nestedSigners?: string[]): string {
  const d = makeTempDir();
  const planPath = join(d, `${SAFE}.plan.json`);
  const plan: Record<string, unknown> = {
    calls: [{ to: '0x4444444444444444444444444444444444444444', value: '0', data: '0xdeadbeef' }],
    callsCount: 1,
    chainId: 1,
    modifierAddress: '0x4444444444444444444444444444444444444444',
    safeAddress: SAFE,
  };
  if (nestedSigners !== undefined) plan['nestedSigners'] = nestedSigners;
  writeFileSync(planPath, JSON.stringify(plan));
  return planPath;
}

describe('cli submit nested-signer emit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submit <file.plan.json> with nestedSigners → main-tx line + one nested-signer line per child with all three hashes', async () => {
    const planPath = writePlan([CHILD_A, CHILD_B]);
    const prevKey = process.env['ZAC_PROPOSER_PRIVATE_KEY'];
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['ZAC_PROPOSER_PRIVATE_KEY'] = TEST_KEY;
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['submit', planPath], { from: 'user' });
      });
    } finally {
      if (prevKey === undefined) delete process.env['ZAC_PROPOSER_PRIVATE_KEY'];
      else process.env['ZAC_PROPOSER_PRIVATE_KEY'] = prevKey;
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }

    // The `submitted ...` line is preserved byte-for-byte (still carries its
    // own messageHash from computeSafeTxMessageHash).
    expect(outErr.stdout).toContain(`safeTxHash=${KNOWN_SAFE_TX_HASH}`);

    // One main-tx line with the parent's three hashes.
    expect(outErr.stdout).toContain(
      `main-tx safe=${SAFE} chain=1 ` +
        `domainHash=${PARENT_DOMAIN_HASH} messageHash=${PARENT_MESSAGE_HASH} safeTxHash=${KNOWN_SAFE_TX_HASH}`,
    );

    const a = computeNestedSafeMessageDetails({
      parentSafeTxHash: KNOWN_SAFE_TX_HASH,
      childSafe: CHILD_A,
      chainId: 1,
    });
    const b = computeNestedSafeMessageDetails({
      parentSafeTxHash: KNOWN_SAFE_TX_HASH,
      childSafe: CHILD_B,
      chainId: 1,
    });
    expect(outErr.stdout).toContain(
      `nested-signer safe=${SAFE} chain=1 child=${CHILD_A} ` +
        `domainHash=${a.domainHash} messageHash=${a.messageHash} nestedHash=${a.nestedHash}`,
    );
    expect(outErr.stdout).toContain(
      `nested-signer safe=${SAFE} chain=1 child=${CHILD_B} ` +
        `domainHash=${b.domainHash} messageHash=${b.messageHash} nestedHash=${b.nestedHash}`,
    );
  });

  it('submit <file.plan.json> WITHOUT nestedSigners → no nested-signer line', async () => {
    const planPath = writePlan(undefined);
    const prevKey = process.env['ZAC_PROPOSER_PRIVATE_KEY'];
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['ZAC_PROPOSER_PRIVATE_KEY'] = TEST_KEY;
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['submit', planPath], { from: 'user' });
      });
    } finally {
      if (prevKey === undefined) delete process.env['ZAC_PROPOSER_PRIVATE_KEY'];
      else process.env['ZAC_PROPOSER_PRIVATE_KEY'] = prevKey;
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }
    expect(outErr.stdout).toContain('submitted');
    expect(outErr.stdout).not.toContain('nested-signer');
    expect(outErr.stdout).not.toContain('main-tx');
  });

  it('submit <dir> bundling → union of nestedSigners across plans, deduped, one line each', async () => {
    // Two plan files in the same safe-dir, overlapping nested signers.
    const root = makeTempDir();
    const dir = join(root, 'mainnet', SAFE);
    mkdirSync(dir, { recursive: true });
    const planBody = (nested: string[], stem: string): void => {
      writeFileSync(join(dir, `${stem}.zac.yaml`), '# x\n');
      writeFileSync(
        join(dir, `${stem}.plan.json`),
        JSON.stringify({
          calls: [
            { to: '0x4444444444444444444444444444444444444444', value: '0', data: '0xdeadbeef' },
          ],
          callsCount: 1,
          chainId: 1,
          modifierAddress: '0x4444444444444444444444444444444444444444',
          nestedSigners: nested,
          safeAddress: SAFE,
        }),
      );
    };
    planBody([CHILD_A], 'a');
    planBody([CHILD_A, CHILD_B], 'b');

    const prevKey = process.env['ZAC_PROPOSER_PRIVATE_KEY'];
    const prevRpc = process.env['MAINNET_RPC_URL'];
    process.env['ZAC_PROPOSER_PRIVATE_KEY'] = TEST_KEY;
    process.env['MAINNET_RPC_URL'] = 'http://stub.invalid';
    let outErr: { stdout: string; stderr: string };
    try {
      outErr = await captureStdout(async () => {
        await buildProgram().parseAsync(['submit', root], { from: 'user' });
      });
    } finally {
      if (prevKey === undefined) delete process.env['ZAC_PROPOSER_PRIVATE_KEY'];
      else process.env['ZAC_PROPOSER_PRIVATE_KEY'] = prevKey;
      if (prevRpc === undefined) delete process.env['MAINNET_RPC_URL'];
      else process.env['MAINNET_RPC_URL'] = prevRpc;
    }

    const a = computeNestedSafeMessageDetails({
      parentSafeTxHash: KNOWN_SAFE_TX_HASH,
      childSafe: CHILD_A,
      chainId: 1,
    });
    const b = computeNestedSafeMessageDetails({
      parentSafeTxHash: KNOWN_SAFE_TX_HASH,
      childSafe: CHILD_B,
      chainId: 1,
    });
    // One main-tx line for the bundled group.
    const mainTxLines = outErr.stdout.split('\n').filter((l) => l.startsWith('main-tx '));
    expect(mainTxLines).toHaveLength(1);
    expect(outErr.stdout).toContain(
      `main-tx safe=${SAFE} chain=1 ` +
        `domainHash=${PARENT_DOMAIN_HASH} messageHash=${PARENT_MESSAGE_HASH} safeTxHash=${KNOWN_SAFE_TX_HASH}`,
    );
    // CHILD_A appears in BOTH plans but is emitted ONCE (deduped union).
    const childALines = outErr.stdout.split('\n').filter((l) => l.includes(`child=${CHILD_A} `));
    expect(childALines).toHaveLength(1);
    expect(outErr.stdout).toContain(
      `child=${CHILD_A} domainHash=${a.domainHash} messageHash=${a.messageHash} nestedHash=${a.nestedHash}`,
    );
    expect(outErr.stdout).toContain(
      `child=${CHILD_B} domainHash=${b.domainHash} messageHash=${b.messageHash} nestedHash=${b.nestedHash}`,
    );
  });
});
