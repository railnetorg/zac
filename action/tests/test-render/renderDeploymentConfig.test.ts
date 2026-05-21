import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfigEnv } from '../../render/configEnv';
import { renderDeploymentConfig } from '../../render/renderDeploymentConfig';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-renderdep-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('renderDeploymentConfig', () => {
  it('T4-10: renders aliases.tokens.USDC to expected value', () => {
    const dir = makeTempDir();
    const cfg = join(dir, 'd.yaml');
    writeFileSync(cfg, 'safe: "{{ aliases.tokens.USDC }}"\n');
    const env = makeConfigEnv({
      searchPaths: [dir],
      aliases: { tokens: { USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } },
    });
    const out = renderDeploymentConfig(env, cfg);
    expect(out).toContain('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });

  it('T4-11: deployment config does NOT have params in scope — {{ params.x }} throws', () => {
    const dir = makeTempDir();
    const cfg = join(dir, 'd.yaml');
    writeFileSync(cfg, 'val: "{{ params.x }}"\n');
    const env = makeConfigEnv({ searchPaths: [dir], aliases: {} });
    expect(() => renderDeploymentConfig(env, cfg)).toThrow();
  });

  it('T4-12: returns a string (no parsing)', () => {
    const dir = makeTempDir();
    const cfg = join(dir, 'd.yaml');
    writeFileSync(cfg, 'k: v\n');
    const env = makeConfigEnv({ searchPaths: [dir], aliases: {} });
    const out = renderDeploymentConfig(env, cfg);
    expect(typeof out).toBe('string');
    expect(out).toContain('k: v');
  });
});
