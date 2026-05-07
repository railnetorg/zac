import { describe, expect, it } from 'vitest';
import { parseYaml } from '../../parse/parseYaml';

describe('parseYaml', () => {
  it('T5-1: parses basic YAML to expected JS', () => {
    const r = parseYaml('a: 1\nb: 2\n');
    expect(r.doc.toJSON()).toEqual({ a: 1, b: 2 });
  });

  it('T5-2: returns the source unchanged', () => {
    const src = 'k: v\n';
    const r = parseYaml(src);
    expect(r.source).toBe(src);
  });

  it('T5-3: lineCounter resolves offset 0 to line 1, col 1', () => {
    const r = parseYaml('k: v\n');
    expect(r.lineCounter.linePos(0)).toEqual({ line: 1, col: 1 });
  });

  it('T5-4: malformed YAML returns doc with errors', () => {
    const r = parseYaml('foo: : :\n');
    expect(r.doc.errors.length).toBeGreaterThan(0);
  });
});
