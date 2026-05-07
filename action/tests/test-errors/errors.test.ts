import { describe, it, expect } from 'vitest';
import { ZacError, formatError } from '../../errors';

describe('errors / formatError', () => {
  it('T2-1: phase + sourceLocation populates output', () => {
    const err = new ZacError({
      phase: 'load',
      message: 'kaboom',
      sourceLocation: { file: '/a.yaml', line: 12, col: 4 },
    });
    const out = formatError(err, { stderr: { isTTY: false }, env: {} });
    expect(out).toContain('phase=load');
    expect(out).toContain('/a.yaml:12:4');
    expect(out).toContain('kaboom');
  });

  it('T2-2: NO_COLOR=1 strips ANSI', () => {
    const err = new ZacError({ phase: 'render', message: 'm' });
    const out = formatError(err, { stderr: { isTTY: true }, env: { NO_COLOR: '1' } });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('T2-3: non-TTY stderr strips ANSI', () => {
    const err = new ZacError({ phase: 'parse', message: 'm' });
    const out = formatError(err, { stderr: { isTTY: false }, env: {} });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('T2-4: TTY + NO_COLOR unset adds ANSI', () => {
    const err = new ZacError({ phase: 'validate', message: 'm' });
    const out = formatError(err, { stderr: { isTTY: true }, env: {} });
    expect(out).toMatch(/\x1b\[/);
  });

  it('T2-5: missing sourceLocation prints phase only', () => {
    const err = new ZacError({ phase: 'emit', message: 'm' });
    const out = formatError(err, { stderr: { isTTY: false }, env: {} });
    expect(out).toContain('phase=emit');
    expect(out).not.toMatch(/:\d+:\d+/);
  });
});
