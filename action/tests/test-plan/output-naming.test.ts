import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  safeDirPlanPathFor,
  planPathFor,
  findSafeDirs,
  findGeneratedConfigs,
} from '../../discover';
import { runPlanForSafeDir } from '../../apply/runPlanForSafeDir';
import { runPlan } from '../../apply/runPlan';
import type { PlanApplyFn } from '../../apply/planSafeDirCalls';
import type { PlanApplyRoleFn, Call } from '../../apply/planRoleCalls';
import { serializePlan } from '../../apply/planSchema';

void writeFile; // unused — keep import surface explicit at module read

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-output-naming-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE_A = '0x3333333333333333333333333333333333333333';
const MOD_A = '0x4444444444444444444444444444444444444444';

function plantTwoSourceSafeDir(): { root: string; safeDir: string } {
  const root = makeTempDir();
  const dir = join(root, 'mainnet', SAFE_A);
  const configDir = join(dir, 'config');
  const genDir = join(dir, 'zac-out');
  const txsDir = join(dir, 'txs');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(genDir, { recursive: true });
  mkdirSync(txsDir, { recursive: true });
  for (const [name, key] of [
    ['a', 'ALPHA'],
    ['b', 'BRAVO'],
  ]) {
    writeFileSync(join(configDir, `${name}.zac.yaml`), '# x\n');
    writeFileSync(
      join(genDir, `${name}.yaml`),
      `deployment:
  chain_id: 1
  safe_address: "${SAFE_A}"
  roles_modifier_address: "${MOD_A}"
roles:
  ${key}:
    members: []
    targets: []
`,
    );
  }
  return { root, safeDir: dir };
}

const fakeEncodeKey = (k: string): `0x${string}` => `0x${k.padEnd(64, '0')}` as `0x${string}`;

function safeInitStub() {
  return async (_cfg: { provider: string; signer?: string; safeAddress: string }) => ({
    createTransaction: async (args: { transactions: Call[] }) => ({
      data: {
        baseGas: '0',
        data: '0xdeadbeef',
        gasPrice: '0',
        gasToken: '0x0000000000000000000000000000000000000000',
        nonce: 0,
        operation: 0,
        refundReceiver: '0x0000000000000000000000000000000000000000',
        safeTxGas: '0',
        to: args.transactions[0]!.to,
        value: '0',
      },
    }),
    getTransactionHash: async () => '0xabc' + '1234567890'.repeat(6) + '12345',
    signHash: async () => ({ data: '0xsig' }),
  });
}

describe('plan output naming', () => {
  it('TS-30: per-safe-dir plan path uses lowercased safe address (under `txs/`)', () => {
    const path = safeDirPlanPathFor({
      dirPath: '/configs/mainnet/0xAaaaAaAaaAAAAaAAAAAAaaAaAaaAaaaAaaaAAAaA',
      safeAddress: '0xAaaaAaAaaAAAAaAAAAAAaaAaAaaAaaaAaaaAAAaA',
    });
    expect(path).toBe(
      join(
        '/configs/mainnet/0xAaaaAaAaaAAAAaAAAAAAaaAaAaaAaaaAaaaAAAaA',
        'txs',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.plan.json',
      ),
    );
  });

  it('TS-31: per-safe-dir plan filename is `<lower-safe-addr>.plan.json` (no leakage of stem)', () => {
    const path = safeDirPlanPathFor({
      dirPath: '/tmp/x/y',
      safeAddress: '0xBBbbbbBBbbbbbbBBbBBBbBBbbbbbBbBbBbbbBbBb',
    });
    expect(path.endsWith('/txs/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.plan.json')).toBe(true);
  });

  it('TS-32: per-file (legacy) plan path is `<safe>/txs/<stem>.plan.json` (sibling of `zac-out/<stem>.yaml`)', () => {
    expect(planPathFor('/x/y/zac-out/aave_safe.yaml')).toBe('/x/y/txs/aave_safe.plan.json');
  });

  it('TS-33: dir-mode default (safe-dir) — one plan file per safe-dir, written as `txs/<safe-addr>.plan.json`', async () => {
    const { root, safeDir } = plantTwoSourceSafeDir();
    const safeDirs = findSafeDirs(root);
    expect(safeDirs).toHaveLength(1);
    const planApply: PlanApplyFn = async () => [
      { to: MOD_A as `0x${string}`, data: '0xdeadbeef' as `0x${string}` },
    ];
    const plan = await runPlanForSafeDir({
      safeDir: safeDirs[0]!,
      planApply,
      encodeKey: fakeEncodeKey,
      safeInit: safeInitStub(),
      rpcUrl: 'http://stub/rpc',
    });
    expect(plan).not.toBeNull();
    const outPath = safeDirPlanPathFor(safeDirs[0]!);
    writeFileSync(outPath, serializePlan(plan!));
    // Exactly one plan file, under `txs/`, named by lowercased safe address.
    expect(outPath).toBe(join(safeDir, 'txs', `${SAFE_A.toLowerCase()}.plan.json`));
  });

  it('TS-34: dir-mode legacy (per-file) — one plan file per source, written under `txs/<stem>.plan.json`', async () => {
    const { root, safeDir } = plantTwoSourceSafeDir();
    const generated = findGeneratedConfigs(root);
    expect(generated).toHaveLength(2);
    const planApplyRole: PlanApplyRoleFn = async () => [
      { to: MOD_A as `0x${string}`, data: '0xfeedface' as `0x${string}` },
    ];
    const outPaths: string[] = [];
    for (const gen of generated) {
      const plan = await runPlan({
        generatedPath: gen,
        planApplyRole,
        encodeKey: fakeEncodeKey,
        safeInit: safeInitStub(),
        rpcUrl: 'http://stub/rpc',
      });
      expect(plan).not.toBeNull();
      const outPath = planPathFor(gen);
      writeFileSync(outPath, serializePlan(plan!));
      outPaths.push(outPath);
    }
    // Two distinct plan files, one per source stem, all under `txs/`.
    expect(outPaths.sort()).toEqual(
      [join(safeDir, 'txs', 'a.plan.json'), join(safeDir, 'txs', 'b.plan.json')].sort(),
    );
  });

  it('TS-35: dir-mode legacy across 2 safe-dirs × 2 sources — 4 <stem>.plan.json under each `txs/`, no <safe-addr>.plan.json, planApplyRole called once per source', async () => {
    // Mirrors what `bun cli plan <root>` does with default flags: walk the
    // root, call legacy runPlan on each generated YAML, write each plan
    // under the safe's `txs/` as <stem>.plan.json. Two safes × two
    // sources = 4 plans total; the per-modifier aggregated
    // <safe-addr>.plan.json should NOT appear anywhere.
    const root = makeTempDir();
    const safes = [
      '0x3333333333333333333333333333333333333333',
      '0x5555555555555555555555555555555555555555',
    ];
    const dirs: string[] = [];
    for (const safe of safes) {
      const dir = join(root, 'mainnet', safe);
      const configDir = join(dir, 'config');
      const genDir = join(dir, 'zac-out');
      const txsDir = join(dir, 'txs');
      mkdirSync(configDir, { recursive: true });
      mkdirSync(genDir, { recursive: true });
      mkdirSync(txsDir, { recursive: true });
      dirs.push(dir);
      for (const [stem, key] of [
        ['a', 'ALPHA'],
        ['b', 'BRAVO'],
      ]) {
        writeFileSync(join(configDir, `${stem}.zac.yaml`), '# x\n');
        writeFileSync(
          join(genDir, `${stem}.yaml`),
          `deployment:
  chain_id: 1
  safe_address: "${safe}"
  roles_modifier_address: "${MOD_A}"
roles:
  ${key}:
    members: []
    targets: []
`,
        );
      }
    }
    const generated = findGeneratedConfigs(root);
    expect(generated).toHaveLength(4);

    let planApplyRoleCalls = 0;
    const planApplyRole: PlanApplyRoleFn = async () => {
      planApplyRoleCalls += 1;
      return [{ to: MOD_A as `0x${string}`, data: '0xfeedface' as `0x${string}` }];
    };
    const outPaths: string[] = [];
    for (const gen of generated) {
      const plan = await runPlan({
        generatedPath: gen,
        planApplyRole,
        encodeKey: fakeEncodeKey,
        safeInit: safeInitStub(),
        rpcUrl: 'http://stub/rpc',
      });
      expect(plan).not.toBeNull();
      const outPath = planPathFor(gen);
      writeFileSync(outPath, serializePlan(plan!));
      outPaths.push(outPath);
    }
    // (c) planApplyRole called exactly once per source.
    expect(planApplyRoleCalls).toBe(4);
    // (a) 4 <stem>.plan.json files at the right locations.
    expect(outPaths.sort()).toEqual(
      [
        join(dirs[0]!, 'txs', 'a.plan.json'),
        join(dirs[0]!, 'txs', 'b.plan.json'),
        join(dirs[1]!, 'txs', 'a.plan.json'),
        join(dirs[1]!, 'txs', 'b.plan.json'),
      ].sort(),
    );
    // (b) no per-modifier <safe-addr>.plan.json was written.
    for (const safe of safes) {
      const dir = join(root, 'mainnet', safe);
      expect(existsSync(join(dir, 'txs', `${safe}.plan.json`))).toBe(false);
    }
  });
});
