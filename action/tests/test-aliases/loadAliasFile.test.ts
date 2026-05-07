import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAliasEnv } from '../../load/aliasEnv';
import { loadAliasFile } from '../../load/loadAliasFile';
import { ZacError } from '../../errors';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-loadalias-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('loadAliasFile', () => {
  it('T3-16: valid YAML returns { data, path }', () => {
    const dir = makeTempDir();
    const p = join(dir, 'a.yaml');
    writeFileSync(p, 'foo: 1\nbar: "x"\n');
    const env = makeAliasEnv();
    const r = loadAliasFile(env, p);
    expect(r.path).toBe(p);
    expect(r.data).toEqual({ foo: 1, bar: 'x' });
  });

  it('T3-17: malformed YAML throws ZacError(load) with sourceLocation', () => {
    const dir = makeTempDir();
    const p = join(dir, 'b.yaml');
    writeFileSync(p, 'foo: : :\n');
    const env = makeAliasEnv();
    try {
      loadAliasFile(env, p);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).phase).toBe('load');
      expect((e as ZacError).sourceLocation?.file).toBe(p);
    }
  });

  it('T3-18: nunjucks expression renders before parse', () => {
    const dir = makeTempDir();
    const p = join(dir, 'c.yaml');
    writeFileSync(p, 'MANAGER: "{{ \'MANAGER\' | keccak }}"\n');
    const env = makeAliasEnv();
    const r = loadAliasFile(env, p);
    expect((r.data as Record<string, string>)['MANAGER']).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('T3-19: alias self-reference throws', () => {
    const dir = makeTempDir();
    const p = join(dir, 'd.yaml');
    writeFileSync(p, 'foo: "{{ aliases.bar }}"\n');
    const env = makeAliasEnv();
    expect(() => loadAliasFile(env, p)).toThrow(ZacError);
  });
});
