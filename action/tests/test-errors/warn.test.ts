import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { warn } from '../../warn';

function makeFakeStderr(isTTY: boolean) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as Writable & { isTTY?: boolean };
  stream.isTTY = isTTY;
  return Object.assign(stream, { _chunks: chunks });
}

describe('warn', () => {
  it('T2-6: writes "WARN: <msg>\\n"', () => {
    const s = makeFakeStderr(false);
    warn('hello', { stderr: s as unknown as NodeJS.WriteStream, env: {} });
    expect((s as unknown as { _chunks: string[] })._chunks.join('')).toBe('WARN: hello\n');
  });

  it('T2-7: TTY + NO_COLOR rules match formatError', () => {
    const tty = makeFakeStderr(true);
    warn('a', { stderr: tty as unknown as NodeJS.WriteStream, env: {} });
    expect((tty as unknown as { _chunks: string[] })._chunks.join('')).toMatch(/\x1b\[/);

    const noColor = makeFakeStderr(true);
    warn('b', { stderr: noColor as unknown as NodeJS.WriteStream, env: { NO_COLOR: '1' } });
    expect((noColor as unknown as { _chunks: string[] })._chunks.join('')).not.toMatch(/\x1b\[/);
  });

  it('T2-8: multiple calls produce one line each', () => {
    const s = makeFakeStderr(false);
    warn('one', { stderr: s as unknown as NodeJS.WriteStream, env: {} });
    warn('two', { stderr: s as unknown as NodeJS.WriteStream, env: {} });
    const out = (s as unknown as { _chunks: string[] })._chunks.join('');
    expect(out.split('\n').filter(Boolean).length).toBe(2);
  });
});
