import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { isAddress, getAddress } from 'viem';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const AAVE = resolve(REPO_ROOT, 'aliases/mainnet/aave.yaml');
const TOKENS = resolve(REPO_ROOT, 'aliases/mainnet/tokens.yaml');

describe('curated aliases', () => {
  it('T9-4: aave.pool is a valid checksummed address', () => {
    const doc = parseDocument(readFileSync(AAVE, 'utf8')).toJSON() as { pool: string };
    expect(isAddress(doc.pool)).toBe(true);
    expect(getAddress(doc.pool)).toBe(doc.pool);
  });

  it('T9-5: every token address is valid + checksummed', () => {
    const doc = parseDocument(readFileSync(TOKENS, 'utf8')).toJSON() as Record<string, string>;
    for (const [k, v] of Object.entries(doc)) {
      expect(isAddress(v)).toBe(true);
      expect(getAddress(v)).toBe(v);
      void k;
    }
  });
});
