import { describe, it, expect, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOutput } from '../../emit/writeOutput';
import { ZacError } from '../../errors';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-emit-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('writeOutput', () => {
  it('T8-11: undefined outPath writes to stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    writeOutput('hello');
    expect(stdoutSpy).toHaveBeenCalledWith('hello');
    stdoutSpy.mockRestore();
  });

  it('T8-12: writes to file', () => {
    const dir = makeTempDir();
    const p = join(dir, 'out.yaml');
    writeOutput('content\n', p);
    expect(readFileSync(p, 'utf8')).toBe('content\n');
  });

  it('T8-13: creates missing parent dirs', () => {
    const dir = makeTempDir();
    const p = join(dir, 'nested', 'deeper', 'out.yaml');
    writeOutput('x\n', p);
    expect(existsSync(p)).toBe(true);
  });

  it('T8-14: existing file is silently overwritten', () => {
    const dir = makeTempDir();
    const p = join(dir, 'out.yaml');
    writeFileSync(p, 'old\n');
    writeOutput('new\n', p);
    expect(readFileSync(p, 'utf8')).toBe('new\n');
  });

  it('T8-15: existing directory path → ZacError', () => {
    const dir = makeTempDir();
    expect(() => writeOutput('x', dir)).toThrow(ZacError);
  });
});
