import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSafeDirs } from '../../discover';
import { ZacError } from '../../errors';
import type { Generated } from '../../apply/parseGenerated';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-find-safedirs-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE_A_LO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE_A_CHK = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
const SAFE_B_LO = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MOD_LO = '0xcccccccccccccccccccccccccccccccccccccccc';
const MOD_OTHER = '0xdddddddddddddddddddddddddddddddddddddddd';

function writeSource(path: string, body: string): void {
  writeFileSync(path, body);
}

function writeGenerated(
  path: string,
  args: {
    chainId: number;
    safeAddress: string;
    modifierAddress: string;
    roleKey?: string;
  },
): void {
  writeFileSync(
    path,
    `deployment:
  chain_id: ${args.chainId}
  safe_address: "${args.safeAddress}"
  roles_modifier_address: "${args.modifierAddress}"
roles:
  ${args.roleKey ?? 'ROLE_A'}:
    members: []
    targets: []
`,
  );
}

/**
 * Create a layout `<root>/<network>/<safeDirName>/config/<name>.zac.yaml`
 * with a matching generated `<root>/<network>/<safeDirName>/zac-out/<name>.yaml`.
 * Returns the source's absolute path.
 */
function plantSource(
  root: string,
  network: string,
  safeDirName: string,
  name: string,
  body: {
    chainId: number;
    safeAddress: string;
    modifierAddress: string;
    roleKey?: string;
  },
): string {
  const safeDir = join(root, network, safeDirName);
  const configDir = join(safeDir, 'config');
  const genDir = join(safeDir, 'zac-out');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(genDir, { recursive: true });
  const src = join(configDir, `${name}.zac.yaml`);
  const gen = join(genDir, `${name}.yaml`);
  writeSource(src, '# rendered separately\n');
  writeGenerated(gen, body);
  return src;
}

describe('findSafeDirs — layout validation', () => {
  it('throws when the safe-address dir is not a 0x-prefixed address', () => {
    const root = makeTempDir();
    const safeDir = join(root, 'mainnet', 'not-an-address');
    const configDir = join(safeDir, 'config');
    const genDir = join(safeDir, 'zac-out');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(genDir, { recursive: true });
    writeSource(join(configDir, 'foo.zac.yaml'), '# x\n');
    writeGenerated(join(genDir, 'foo.yaml'), {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
    });
    expect(() => findSafeDirs(root)).toThrowError(ZacError);
    try {
      findSafeDirs(root);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('config/<name>.zac.yaml layout');
    }
  });

  it('throws when the grandparent dir is not a known network', () => {
    const root = makeTempDir();
    plantSource(root, 'narnia', SAFE_A_LO, 'foo', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
    });
    expect(() => findSafeDirs(root)).toThrowError(ZacError);
    try {
      findSafeDirs(root);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain("unknown network directory 'narnia'");
    }
  });

  it('throws when YAML safe_address does not match the parent dir name', () => {
    const root = makeTempDir();
    plantSource(root, 'mainnet', SAFE_A_LO, 'foo', {
      chainId: 1,
      safeAddress: SAFE_B_LO,
      modifierAddress: MOD_LO,
    });
    expect(() => findSafeDirs(root)).toThrowError(ZacError);
    try {
      findSafeDirs(root);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('safe_address mismatch');
    }
  });

  it('siblings disagree on chain_id → throws', () => {
    const root = makeTempDir();
    plantSource(root, 'mainnet', SAFE_A_LO, 'a', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
      roleKey: 'A',
    });
    plantSource(root, 'mainnet', SAFE_A_LO, 'b', {
      chainId: 137, // wrong
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
      roleKey: 'B',
    });
    expect(() => findSafeDirs(root)).toThrowError(ZacError);
    try {
      findSafeDirs(root);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('chain_id mismatch');
    }
  });

  it('siblings disagree on modifier address → throws', () => {
    const root = makeTempDir();
    plantSource(root, 'mainnet', SAFE_A_LO, 'a', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
      roleKey: 'A',
    });
    plantSource(root, 'mainnet', SAFE_A_LO, 'b', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_OTHER,
      roleKey: 'B',
    });
    expect(() => findSafeDirs(root)).toThrowError(ZacError);
    try {
      findSafeDirs(root);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('roles_modifier_address mismatch');
    }
  });

  it('happy path: one source under <network>/<safe>/', () => {
    const root = makeTempDir();
    const src = plantSource(root, 'mainnet', SAFE_A_LO, 'foo', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
    });
    const safeDirs = findSafeDirs(root);
    expect(safeDirs).toHaveLength(1);
    expect(safeDirs[0]!.chainId).toBe(1);
    expect(safeDirs[0]!.safeAddress).toBe(SAFE_A_LO);
    expect(safeDirs[0]!.modifierAddress).toBe(MOD_LO);
    expect(safeDirs[0]!.network).toBe('mainnet');
    expect(safeDirs[0]!.sources).toEqual([src]);
  });

  it('safe_address dir-match is case-insensitive', () => {
    // Dir name is lowercase, YAML body is checksummed (mixed case) — passes.
    const root = makeTempDir();
    plantSource(root, 'mainnet', SAFE_A_LO, 'foo', {
      chainId: 1,
      safeAddress: SAFE_A_CHK,
      modifierAddress: MOD_LO,
    });
    expect(() => findSafeDirs(root)).not.toThrow();
  });

  it('file mode: a single .zac.yaml under a valid safe-dir', () => {
    const root = makeTempDir();
    const src = plantSource(root, 'mainnet', SAFE_A_LO, 'foo', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
    });
    const safeDirs = findSafeDirs(src);
    expect(safeDirs).toHaveLength(1);
    expect(safeDirs[0]!.sources).toEqual([src]);
  });

  it('empty dir under a valid layout → empty array (no sources to plan)', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'mainnet', SAFE_A_LO), { recursive: true });
    // Walk finds nothing because there's nothing to find — the call returns
    // []; the CLI surfaces "no matching files found" upstream.
    expect(findSafeDirs(root)).toEqual([]);
  });

  it('two safe-dirs across two networks → two entries, deterministically ordered', () => {
    const root = makeTempDir();
    plantSource(root, 'sepolia', SAFE_B_LO, 'b', {
      chainId: 11155111,
      safeAddress: SAFE_B_LO,
      modifierAddress: MOD_LO,
    });
    plantSource(root, 'mainnet', SAFE_A_LO, 'a', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
    });
    const safeDirs = findSafeDirs(root);
    expect(safeDirs).toHaveLength(2);
    // Sort is by absolute dirPath; both share a common prefix so the path's
    // suffix decides — "mainnet/..." < "sepolia/..." alphabetically.
    expect(safeDirs[0]!.network).toBe('mainnet');
    expect(safeDirs[1]!.network).toBe('sepolia');
  });

  it('missing generated `.yaml` → load error pointing the user to `zac generate`', () => {
    const root = makeTempDir();
    const configDir = join(root, 'mainnet', SAFE_A_LO, 'config');
    mkdirSync(configDir, { recursive: true });
    writeSource(join(configDir, 'foo.zac.yaml'), '# x\n');
    // No zac-out/ companion written.
    expect(() => findSafeDirs(root)).toThrowError(ZacError);
    try {
      findSafeDirs(root);
    } catch (e) {
      expect((e as ZacError).phase).toBe('load');
      expect((e as ZacError).message).toContain('missing generated config');
      expect((e as ZacError).message).toContain('zac generate');
    }
  });

  it('two sources in one safe-dir agreeing on (chain, safe, modifier) → one SafeDir with both sources', () => {
    const root = makeTempDir();
    plantSource(root, 'mainnet', SAFE_A_LO, 'a', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
      roleKey: 'A',
    });
    plantSource(root, 'mainnet', SAFE_A_LO, 'b', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
      roleKey: 'B',
    });
    const safeDirs = findSafeDirs(root);
    expect(safeDirs).toHaveLength(1);
    expect(safeDirs[0]!.sources).toHaveLength(2);
    // Sorted alphabetically — `a.zac.yaml` first.
    expect(safeDirs[0]!.sources[0]!).toMatch(/a\.zac\.yaml$/);
    expect(safeDirs[0]!.sources[1]!).toMatch(/b\.zac\.yaml$/);
  });

  it('injectable parseGenerated stub bypasses parseGenerated entirely (DI sanity check)', () => {
    const root = makeTempDir();
    const safeDir = join(root, 'mainnet', SAFE_A_LO);
    const configDir = join(safeDir, 'config');
    const genDir = join(safeDir, 'zac-out');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(genDir, { recursive: true });
    writeSource(join(configDir, 'foo.zac.yaml'), '# x\n');
    // Generated file just has to EXIST — content is read by the stub.
    writeFileSync(join(genDir, 'foo.yaml'), '');
    const stub = (_p: string): Generated => ({
      deployment: {
        chain_id: 1,
        safe_address: SAFE_A_LO,
        roles_modifier_address: MOD_LO,
      },
      roles: {},
    });
    const safeDirs = findSafeDirs(root, { parseGenerated: stub });
    expect(safeDirs).toHaveLength(1);
    expect(safeDirs[0]!.modifierAddress).toBe(MOD_LO);
  });

  it('returns the SAFE-ADDRESS dir, NOT the `config/` subdir, as dirPath', () => {
    const root = makeTempDir();
    const src = plantSource(root, 'mainnet', SAFE_A_LO, 'foo', {
      chainId: 1,
      safeAddress: SAFE_A_LO,
      modifierAddress: MOD_LO,
    });
    const safeDirs = findSafeDirs(root);
    expect(safeDirs).toHaveLength(1);
    expect(safeDirs[0]!.dirPath).toBe(join(root, 'mainnet', SAFE_A_LO));
    // Sanity: the source path lives one level deeper, in `config/`.
    expect(src).toBe(join(safeDirs[0]!.dirPath, 'config', 'foo.zac.yaml'));
  });
});
