import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllAliases } from '../../load/loadAllAliases';
import { ZacError } from '../../errors';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE_CONFIG = resolve(__dirname, '../fixtures/host-repo/config.yaml');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-loadall-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('loadAllAliases', () => {
  it('T3-25: returns merged registry with expected entries', () => {
    const r = loadAllAliases({ configPath: FIXTURE_CONFIG, network: 'mainnet' });
    const tokens = r.merged['tokens'] as Record<string, string>;
    const signers = r.merged['signers'] as Record<string, string>;
    expect(tokens['USDC']).toMatch(/^0x[A-Fa-f0-9]{40}$/);
    expect(signers['alice']).toMatch(/^0x[A-Fa-f0-9]{40}$/);
  });

  it('T3-26: missing alias file path errors with phase=load', () => {
    const d = makeTempDir();
    const cfg = join(d, 'config.yaml');
    writeFileSync(cfg, 'aliases:\n  mainnet:\n    tokens: ./missing.yaml\n');
    try {
      loadAllAliases({ configPath: cfg, network: 'mainnet' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).phase).toBe('load');
    }
  });

  it('T3-27: namespace declaration order does not matter', () => {
    const r = loadAllAliases({ configPath: FIXTURE_CONFIG, network: 'mainnet' });
    expect(Object.keys(r.merged).sort()).toEqual(
      ['aave', 'modifiers', 'safes', 'signers', 'tokens'].sort(),
    );
  });
});
