import { describe, expect, it } from 'vitest';
import { bool } from '../../render/boolFilter';
import { makeConfigEnv } from '../../render/configEnv';

describe('boolFilter', () => {
  it('T13-1: real booleans pass through unchanged', () => {
    expect(bool(true)).toBe(true);
    expect(bool(false)).toBe(false);
  });

  it('T13-2: a quoted boolean is rejected, which is the whole point', () => {
    // `borrow: "false"` is a non-empty string, and a non-empty string is truthy in
    // nunjucks — so without this filter the value an author wrote to CLOSE a gate
    // opens it. Failing open is the reason the check exists.
    for (const v of ['false', 'true', '0', '1', 'no', 'yes']) {
      expect(() => bool(v)).toThrow(/must be a YAML boolean/);
    }
  });

  it('T13-3: non-string non-booleans are rejected too', () => {
    for (const v of [0, 1, null, [], {}]) {
      expect(() => bool(v)).toThrow(/must be a YAML boolean/);
    }
  });

  it('T13-4: the message names the param and shows what was received', () => {
    expect(() => bool('false', 'borrow')).toThrow(/template param 'borrow'/);
    expect(() => bool('false', 'borrow')).toThrow(/got string "false"/);
    // Without a name it still says what it wanted, just less usefully.
    expect(() => bool('false')).toThrow(/a boolean template param/);
  });

  it('T13-5: the filter is registered on the production environment', () => {
    // Registered in `makeConfigEnv`, not hand-added per call site — a template that
    // uses `| bool` has to work in the environment the CLI actually renders with.
    const env = makeConfigEnv({ searchPaths: [], aliases: {} });
    expect(env.renderString('{{ v | bool }}', { v: false }).trim()).toBe('false');
    expect(() => env.renderString('{{ v | bool("flag") }}', { v: 'false' })).toThrow(
      /template param 'flag'/,
    );
  });
});
