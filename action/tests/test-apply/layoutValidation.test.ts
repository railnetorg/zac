import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findZacSources,
  findGeneratedConfigs,
  findPlans,
  generatedPathFor,
  planPathFor,
  sourcePathFor,
} from '../../discover';
import { ZacError } from '../../errors';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-layout-validation-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE = '0x3333333333333333333333333333333333333333';

describe('layout validator — tri-folder layout (`config/`, `zac-out/`, `txs/`)', () => {
  it('rejects a `.zac.yaml` placed directly under `<safe>/` (no `config/` parent)', () => {
    // File-mode: explicit path must satisfy the strict layout.
    const root = makeTempDir();
    const dir = join(root, 'mainnet', SAFE);
    mkdirSync(dir, { recursive: true });
    const src = join(dir, 'foo.zac.yaml');
    writeFileSync(src, '# x\n');
    expect(() => findZacSources(src)).toThrowError(ZacError);
    try {
      findZacSources(src);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('config/<name>.zac.yaml layout');
    }
  });

  it('rejects a `.zac.yaml` placed under `<safe>/some-other-dir/foo.zac.yaml`', () => {
    // The immediate parent must be literally `config` — any other dir
    // name (even alongside a valid safe-address grandparent) fails.
    const root = makeTempDir();
    const dir = join(root, 'mainnet', SAFE, 'some-other-dir');
    mkdirSync(dir, { recursive: true });
    const src = join(dir, 'foo.zac.yaml');
    writeFileSync(src, '# x\n');
    expect(() => findZacSources(src)).toThrowError(ZacError);
    try {
      findZacSources(src);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('config/<name>.zac.yaml layout');
    }
  });

  it('directory-mode silently skips `.zac.yaml` files outside a `config/` subdir', () => {
    // Walker filters at discovery time — files outside `config/` are
    // irrelevant to ZAC and not surfaced as errors here.
    const root = makeTempDir();
    const dir = join(root, 'mainnet', SAFE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stray.zac.yaml'), '# x\n');
    mkdirSync(join(dir, 'random-subdir'), { recursive: true });
    writeFileSync(join(dir, 'random-subdir', 'other.zac.yaml'), '# x\n');
    // No `config/` planted at all → empty result.
    expect(findZacSources(root)).toEqual([]);
  });

  it('directory-mode accepts `.zac.yaml` files under `<safe>/config/`', () => {
    const root = makeTempDir();
    const configDir = join(root, 'mainnet', SAFE, 'config');
    mkdirSync(configDir, { recursive: true });
    const src = join(configDir, 'foo.zac.yaml');
    writeFileSync(src, '# x\n');
    expect(findZacSources(root)).toEqual([src]);
  });

  it('directory-mode walker filters generated `.yaml` to those under `zac-out/`', () => {
    const root = makeTempDir();
    const safeDir = join(root, 'mainnet', SAFE);
    const configDir = join(safeDir, 'config');
    const genDir = join(safeDir, 'zac-out');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(genDir, { recursive: true });
    // Source + companion generated under the right dirs — accepted.
    writeFileSync(join(configDir, 'foo.zac.yaml'), '# x\n');
    writeFileSync(join(genDir, 'foo.yaml'), '# generated\n');
    // A stray `.yaml` next to the safe dir — must NOT be surfaced.
    writeFileSync(join(safeDir, 'stray.yaml'), '# stray\n');
    const found = findGeneratedConfigs(root);
    expect(found).toEqual([join(genDir, 'foo.yaml')]);
  });

  it('directory-mode walker filters plan `*.plan.json` to those under `txs/`', () => {
    const root = makeTempDir();
    const safeDir = join(root, 'mainnet', SAFE);
    const txsDir = join(safeDir, 'txs');
    mkdirSync(txsDir, { recursive: true });
    writeFileSync(join(txsDir, 'foo.plan.json'), '{}');
    // A stray `.plan.json` next to the safe dir — must NOT be surfaced.
    writeFileSync(join(safeDir, 'stray.plan.json'), '{}');
    const found = findPlans(root);
    expect(found).toEqual([join(txsDir, 'foo.plan.json')]);
  });
});

describe('path helpers — round-trip across the tri-folder layout', () => {
  it('source → generated → plan → back to source is the identity', () => {
    const src = `/configs/mainnet/${SAFE}/config/aave_safe.zac.yaml`;
    const gen = generatedPathFor(src);
    expect(gen).toBe(`/configs/mainnet/${SAFE}/zac-out/aave_safe.yaml`);
    const plan = planPathFor(gen);
    expect(plan).toBe(`/configs/mainnet/${SAFE}/txs/aave_safe.plan.json`);
    const backToSrc = sourcePathFor(gen);
    expect(backToSrc).toBe(src);
  });

  it('generatedPathFor jumps from `config/` to `zac-out/` (not just a suffix swap)', () => {
    expect(generatedPathFor(`/configs/mainnet/${SAFE}/config/aave_safe.zac.yaml`)).toBe(
      `/configs/mainnet/${SAFE}/zac-out/aave_safe.yaml`,
    );
  });

  it('sourcePathFor jumps from `zac-out/` to `config/`', () => {
    expect(sourcePathFor(`/configs/mainnet/${SAFE}/zac-out/aave_safe.yaml`)).toBe(
      `/configs/mainnet/${SAFE}/config/aave_safe.zac.yaml`,
    );
  });

  it('planPathFor jumps from `zac-out/` to `txs/`', () => {
    expect(planPathFor(`/configs/mainnet/${SAFE}/zac-out/aave_safe.yaml`)).toBe(
      `/configs/mainnet/${SAFE}/txs/aave_safe.plan.json`,
    );
  });
});
