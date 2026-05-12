import { describe, it, expect } from 'vitest';
import { ZacError, formatError } from '../../errors';

describe('formatError integration with templateLocation', () => {
  it('T7-7: templateLocation with line populates output without rendered mention', () => {
    const err = new ZacError({
      phase: 'validate',
      message: 'kaboom',
      templateLocation: { file: '/templates/t.tmpl', line: 12 },
    });
    const out = formatError(err, { stderr: { isTTY: false }, env: {} });
    expect(out).toContain('/templates/t.tmpl:12');
    expect(out).toContain('phase=validate');
    expect(out).not.toContain('rendered');
  });

  it('T7-8: templateLocation.line=null falls back to sourceLocation with note', () => {
    const err = new ZacError({
      phase: 'validate',
      message: 'kaboom',
      sourceLocation: { file: '/rendered.yaml', line: 5, col: 3 },
      templateLocation: {
        file: '/templates/t.tmpl',
        line: null,
        note: 'could not uniquely map to template line; check rendered output at /rendered.yaml:5',
      },
    });
    const out = formatError(err, { stderr: { isTTY: false }, env: {} });
    expect(out).toContain('/rendered.yaml:5:3');
    expect(out).toContain('could not uniquely map');
  });

  it('T7-9: end-to-end smoke — ZacError chains work for a validate-phase error', () => {
    // Build a synthetic error using the real heuristic-style location.
    const err = new ZacError({
      phase: 'validate',
      message: "value_type 'uint256' does not match signature parameter type 'address'",
      templateLocation: { file: '/templates/aave_v3/aave_v3.tmpl', line: 7 },
    });
    const out = formatError(err, { stderr: { isTTY: false }, env: {} });
    expect(out).toMatch(/phase=validate \/templates\/aave_v3\/aave_v3\.tmpl:7/);
    expect(out).toContain('does not match signature');
  });
});
