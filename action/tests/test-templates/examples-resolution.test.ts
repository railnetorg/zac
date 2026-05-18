import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');

describe('examples path resolution', () => {
  it('T9-6: alias paths in examples/config.yaml resolve to existing files', () => {
    // walk-up from examples/mainnet/<safe-addr>/config/aave_safe.zac.yaml
    // finds examples/config.yaml.
    expect(existsSync(resolve(REPO_ROOT, 'examples/config.yaml'))).toBe(true);
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'examples/mainnet/0x3333333333333333333333333333333333333333/config/aave_safe.zac.yaml',
        ),
      ),
    ).toBe(true);
    // Curated aliases referenced via ../aliases/*
    expect(existsSync(resolve(REPO_ROOT, 'aliases/mainnet/aave.yaml'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'aliases/mainnet/tokens.yaml'))).toBe(true);
    // Local-to-examples aliases
    expect(existsSync(resolve(REPO_ROOT, 'examples/aliases/signers.yaml'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'examples/aliases/mainnet/safes.yaml'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'examples/aliases/mainnet/modifiers.yaml'))).toBe(true);
  });
});
