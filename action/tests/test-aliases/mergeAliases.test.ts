import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deepMergeWithWarn, mergeGlobalNetwork, mergeNamespace } from '../../load/mergeAliases';

let stderrSpy: ReturnType<typeof vi.spyOn>;
let written: string;

beforeEach(() => {
  written = '';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown): boolean => {
    written += typeof c === 'string' ? c : (c as Buffer).toString();
    return true;
  });
});
afterEach(() => stderrSpy.mockRestore());

describe('mergeAliases', () => {
  it('T3-20: deep merge disjoint keys, no warning', () => {
    const out = deepMergeWithWarn(
      { a: { b: 1 } },
      { a: { c: 2 } },
      { namespace: 'tokens', pathSoFar: [], sourceA: 'A', sourceB: 'B' },
    );
    expect(out).toEqual({ a: { b: 1, c: 2 } });
    expect(written).toBe('');
  });

  it('T3-21: deep merge override emits warning', () => {
    const out = deepMergeWithWarn(
      { a: { b: 1 } },
      { a: { b: 2 } },
      { namespace: 'tokens', pathSoFar: [], sourceA: 'A.yaml', sourceB: 'B.yaml' },
    );
    expect(out).toEqual({ a: { b: 2 } });
    expect(written).toContain('alias override at tokens.a.b');
  });

  it('T3-22: list-of-paths order: B overrides A', () => {
    const out = mergeNamespace({
      namespace: 'tokens',
      files: [
        { path: 'A.yaml', data: { x: 1 } },
        { path: 'B.yaml', data: { x: 2 } },
      ],
    });
    expect(out).toEqual({ x: 2 });
  });

  it('T3-23: global vs network — network wins', () => {
    const out = mergeGlobalNetwork({
      namespace: 'tokens',
      globalData: { USDC: 'A' },
      networkData: { USDC: 'B' },
      globalSource: 'g.yaml',
      networkSource: 'n.yaml',
    });
    expect(out).toEqual({ USDC: 'B' });
  });

  it('T3-24: override warning text includes namespace, key, both file paths', () => {
    deepMergeWithWarn(
      { a: 1 },
      { a: 2 },
      { namespace: 'foo', pathSoFar: [], sourceA: 'first.yaml', sourceB: 'second.yaml' },
    );
    expect(written).toContain('foo.a');
    expect(written).toContain('first.yaml');
    expect(written).toContain('second.yaml');
  });
});
