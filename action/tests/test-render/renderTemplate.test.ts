import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConfigEnv } from '../../render/configEnv';
import { renderTemplate } from '../../render/renderTemplate';
import { ZacError } from '../../errors';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES = resolve(__dirname, '../fixtures/templates');

describe('renderTemplate', () => {
  it('T4-13: params.greeting renders to value', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    const out = renderTemplate(env, {
      templatePath: 'simple.tmpl',
      params: { greeting: '0x123' },
    });
    expect(out).toContain('0x123');
  });

  it('T4-14: params context isolation between calls', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    renderTemplate(env, { templatePath: 'simple.tmpl', params: { greeting: 'A' } });
    // Second call with a different params must not leak from the first.
    expect(() =>
      renderTemplate(env, {
        templatePath: 'simple.tmpl',
        params: {} as Record<string, unknown>,
      }),
    ).toThrow(); // greeting is undefined now
  });

  it('T4-15: missing param key throws ZacError', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    expect(() => renderTemplate(env, { templatePath: 'simple.tmpl', params: {} })).toThrow(
      ZacError,
    );
  });

  it('T4-16: loop renders one block per element, no blank lines', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    const out = renderTemplate(env, {
      templatePath: 'with_loop.tmpl',
      params: {
        deposit_assets: [
          { address: '0x1', symbol: 'A' },
          { address: '0x2', symbol: 'B' },
        ],
      },
    });
    expect(out).toContain('address: "0x1"');
    expect(out).toContain('symbol: "A"');
    expect(out).toContain('address: "0x2"');
    expect(out).toContain('symbol: "B"');
    // Whitespace control: no blank lines between role entries.
    expect(out).not.toMatch(/\n\s*\n/);
  });
});
