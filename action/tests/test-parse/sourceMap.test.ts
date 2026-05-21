import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseYaml } from '../../parse/parseYaml';
import { sourceMap } from '../../parse/sourceMap';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = resolve(__dirname, '../fixtures/rendered/basic.yaml');

describe('sourceMap', () => {
  it('T5-5: top-level key resolves to line 1', () => {
    const src = 'a: 1\nb: 2\n';
    const parsed = parseYaml(src);
    const loc = sourceMap(parsed, ['a'], 'inline');
    expect(loc).not.toBeNull();
    expect(loc!.line).toBe(1);
  });

  it('T5-6: nested key resolves to its line', () => {
    const src = readFileSync(FIXTURE, 'utf8');
    const parsed = parseYaml(src);
    const loc = sourceMap(parsed, ['parent', 'child'], FIXTURE);
    expect(loc).not.toBeNull();
    // "  child: x" appears on line 2 in the fixture (1-indexed).
    expect(loc!.line).toBe(2);
  });

  it('T5-7: list index resolves correctly', () => {
    const src = readFileSync(FIXTURE, 'utf8');
    const parsed = parseYaml(src);
    const loc = sourceMap(parsed, ['items', 0], FIXTURE);
    expect(loc).not.toBeNull();
    // "items:" is line 3, "  - foo" is line 4 (1-indexed).
    expect(loc!.line).toBe(4);
  });

  it('T5-8: anchor + alias both resolve without off-by-one', () => {
    const src = readFileSync(FIXTURE, 'utf8');
    const parsed = parseYaml(src);
    const anchorLoc = sourceMap(parsed, ['anchored', 'k'], FIXTURE);
    const refLoc = sourceMap(parsed, ['ref'], FIXTURE);
    expect(anchorLoc).not.toBeNull();
    expect(refLoc).not.toBeNull();
    // "anchored: &a" is line 6, "  k: 1" is line 7.
    expect(anchorLoc!.line).toBe(7);
    // "ref: *a" is line 8.
    expect(refLoc!.line).toBe(8);
  });

  it('T5-9: missing path returns null', () => {
    const parsed = parseYaml('a: 1\n');
    const loc = sourceMap(parsed, ['nonexistent'], 'inline');
    expect(loc).toBeNull();
  });
});
