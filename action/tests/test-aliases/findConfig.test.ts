import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfig } from '../../load/findConfig';
import { ZacError } from '../../errors';

const tempDirs: string[] = [];
function makeTempDir(prefix = 'zac-findconfig-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('findConfig', () => {
  it('T3-1: walk-up from mainnet/x.yaml finds config.yaml two levels up', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'config.yaml'), 'aliases: {}\n');
    mkdirSync(join(root, 'mainnet'));
    writeFileSync(join(root, 'mainnet', 'x.yaml'), '');
    const found = findConfig({ startDir: join(root, 'mainnet') });
    expect(found).toBe(join(root, 'config.yaml'));
  });

  it('T3-2: walk-up with no config errors with expected message', () => {
    const root = makeTempDir();
    // Create a .git marker at root so the walk stops without reaching the user's real git repo.
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'mainnet'));
    expect(() => findConfig({ startDir: join(root, 'mainnet') })).toThrow(ZacError);
    try {
      findConfig({ startDir: join(root, 'mainnet') });
    } catch (e) {
      expect((e as ZacError).message).toContain('config.yaml not found');
      expect((e as ZacError).phase).toBe('load');
    }
  });

  it('T3-3: walk-up stops at .git boundary even if config.yaml exists higher', () => {
    const grandparent = makeTempDir();
    writeFileSync(join(grandparent, 'config.yaml'), 'aliases: {}\n');
    const repo = join(grandparent, 'repo');
    mkdirSync(repo);
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'mainnet'));
    expect(() => findConfig({ startDir: join(repo, 'mainnet') })).toThrow(ZacError);
  });

  it('T3-4: --config <existing> bypasses walk', () => {
    const root = makeTempDir();
    const overridePath = join(root, 'custom.yaml');
    writeFileSync(overridePath, 'aliases: {}\n');
    const found = findConfig({ startDir: '/anywhere', override: overridePath });
    expect(found).toBe(overridePath);
  });

  it('T3-5: --config <nonexistent> errors eagerly', () => {
    expect(() => findConfig({ startDir: '/x', override: '/nope/config.yaml' })).toThrow(ZacError);
  });
});
