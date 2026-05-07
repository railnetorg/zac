import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES = resolve(__dirname, '../fixtures/templates');

describe('configEnv', () => {
  it('T4-4: throwOnUndefined catches missing aliases.foo', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    expect(() => env.renderString('{{ aliases.foo }}', {})).toThrow();
  });

  it('T4-5: nested undefined throws (aliases.tokens.UNKNOWN where tokens exists)', () => {
    const env = makeConfigEnv({
      searchPaths: [FIXTURES],
      aliases: { tokens: { USDC: '0xaaa' } },
    });
    expect(() => env.renderString('{{ aliases.tokens.UNKNOWN }}', {})).toThrow();
  });

  it('T4-6: include from curated _macros/m.tmpl resolves', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    const out = env.renderString('{%- include "_macros/m.tmpl" -%}', {});
    // The macro file just defines a macro; the include itself produces empty output.
    expect(out.trim()).toBe('');
  });

  it('T4-7: from-import + macro call', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    const out = env.render('with_macro.tmpl', {});
    expect(out).toContain('0xabc # Alice');
    expect(out).toContain('0xdef # Bob');
  });

  it('T4-8: deployment-config-dir loader takes precedence over curated', () => {
    const dep = mkdtempSync(join(tmpdir(), 'zac-render-prec-'));
    try {
      writeFileSync(join(dep, 'simple.tmpl'), 'OVERRIDDEN: "{{ greeting }}"\n');
      // searchPaths: dep first, FIXTURES second — dep should win.
      const env = makeConfigEnv({ searchPaths: [dep, FIXTURES], aliases: {} });
      const out = env.render('simple.tmpl', { greeting: 'hi' });
      expect(out).toContain('OVERRIDDEN');
    } finally {
      rmSync(dep, { recursive: true, force: true });
    }
  });

  it('T4-9: keccak filter is registered', () => {
    const env = makeConfigEnv({ searchPaths: [FIXTURES], aliases: {} });
    expect(typeof env.getFilter('keccak')).toBe('function');
  });
});
