import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZacError } from '../../errors';
import { parseAndValidateSafeYaml } from '../../validate/safeConfigSchema';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-safe-yaml-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const GUARD = '0x1234567890123456789012345678901234567890';
const FALLBACK = '0x2345678901234567890123456789012345678901';
const MOD_A = '0x3456789012345678901234567890123456789012';
const MOD_B = '0x4567890123456789012345678901234567890123';
const ZERO = '0x0000000000000000000000000000000000000000';

function writeYaml(body: string): string {
  const d = makeTempDir();
  const path = join(d, 'safe.yaml');
  writeFileSync(path, body);
  // Need a config.yaml in configDir for the nunjucks env's search paths
  // (not strictly required since safe.yaml here uses no includes, but
  // sets up the realistic path layout).
  return path;
}

function defaultOpts(path: string, aliasesExtra: Record<string, unknown> = {}) {
  return {
    path,
    aliases: { ...aliasesExtra, ZERO },
    configDir: join(path, '..'),
    network: 'mainnet',
  };
}

describe('parseAndValidateSafeYaml', () => {
  it('happy path: all keys with valid addresses → returns parsed object', () => {
    const path = writeYaml(`guard: "${GUARD}"
fallback: "${FALLBACK}"
modules:
  - "${MOD_A}"
  - "${MOD_B}"
`);
    const result = parseAndValidateSafeYaml(defaultOpts(path));
    expect(result.guard).toBe(GUARD);
    expect(result.fallback).toBe(FALLBACK);
    expect(result.modules).toEqual([MOD_A, MOD_B]);
  });

  it('`guard: ~` → guard: null', () => {
    const path = writeYaml(`guard: ~
fallback: ~
modules: ~
`);
    const result = parseAndValidateSafeYaml(defaultOpts(path));
    expect(result.guard).toBeNull();
    expect(result.fallback).toBeNull();
    expect(result.modules).toBeNull();
  });

  it('missing `guard` → ZacError(validate) with "is required" message', () => {
    const path = writeYaml(`fallback: ~
modules: ~
`);
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain("'guard' is required");
    }
  });

  it('missing `fallback` → ZacError(validate)', () => {
    const path = writeYaml(`guard: ~
modules: ~
`);
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).message).toContain("'fallback' is required");
    }
  });

  it('missing `modules` → ZacError(validate)', () => {
    const path = writeYaml(`guard: ~
fallback: ~
`);
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).message).toContain("'modules' is required");
    }
  });

  it('invalid hex in `guard` → ZacError(validate) with "invalid address" message', () => {
    const path = writeYaml(`guard: "0xnothex"
fallback: ~
modules: ~
`);
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain("'guard': invalid address");
    }
  });

  it('invalid hex in `modules` array element → ZacError(validate)', () => {
    const path = writeYaml(`guard: ~
fallback: ~
modules:
  - "0xnothex"
`);
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).message).toContain("'modules': invalid address");
    }
  });

  it('duplicate non-zero in `modules` → ZacError(validate)', () => {
    const path = writeYaml(`guard: ~
fallback: ~
modules:
  - "${MOD_A}"
  - "${MOD_A}"
`);
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).message).toContain('contains duplicate');
    }
  });

  it('duplicates that collapse via `0x0` filter → no error', () => {
    const path = writeYaml(`guard: ~
fallback: ~
modules:
  - "${ZERO}"
  - "${ZERO}"
  - "${MOD_A}"
`);
    // Two zeros are filtered; one MOD_A remaining — no duplicate.
    const result = parseAndValidateSafeYaml(defaultOpts(path));
    expect(result.modules).toEqual([ZERO, ZERO, MOD_A]);
  });

  it('nunjucks: `{{ aliases.ZERO }}` resolves to the zero-address constant', () => {
    const path = writeYaml(`guard: "{{ aliases.ZERO }}"
fallback: ~
modules: ~
`);
    const result = parseAndValidateSafeYaml(defaultOpts(path));
    expect(result.guard).toBe(ZERO);
  });

  it('empty file → ZacError(parse)', () => {
    const path = writeYaml('');
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).phase).toBe('parse');
    }
  });

  it('YAML parse error → ZacError(parse)', () => {
    const path = writeYaml('guard: [bad yaml\n');
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).phase).toBe('parse');
    }
  });

  it('file missing → ZacError(load) with "not found in <dir>" message', () => {
    const d = makeTempDir();
    const path = join(d, 'safe.yaml');
    // Don't write the file.
    expect(() =>
      parseAndValidateSafeYaml({
        path,
        aliases: { ZERO },
        configDir: d,
        network: 'mainnet',
      }),
    ).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml({
        path,
        aliases: { ZERO },
        configDir: d,
        network: 'mainnet',
      });
    } catch (e) {
      expect((e as ZacError).phase).toBe('load');
      expect((e as ZacError).message).toContain('safe.yaml not found in');
    }
  });

  it('nunjucks render error (undefined alias) → ZacError(render)', () => {
    const path = writeYaml(`guard: "{{ aliases.MISSING }}"
fallback: ~
modules: ~
`);
    expect(() => parseAndValidateSafeYaml(defaultOpts(path))).toThrowError(ZacError);
    try {
      parseAndValidateSafeYaml(defaultOpts(path));
    } catch (e) {
      expect((e as ZacError).phase).toBe('render');
    }
  });
});
