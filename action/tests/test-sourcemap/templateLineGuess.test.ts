import { describe, it, expect } from 'vitest';
import { templateLineGuess } from '../../sourceMap/templateLineGuess';

describe('templateLineGuess', () => {
  it('T7-1: unique match returns correct template line', () => {
    const template = [
      'header:',
      '  k: 1',
      '  approve_USDC: 0xUSDC_ADDRESS_PLACEHOLDER',
      '  k: 2',
    ].join('\n');
    const rendered = [
      'header:',
      '  k: 1',
      '  approve_USDC: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      '  k: 2',
    ].join('\n');
    const r = templateLineGuess({
      renderedPath: '/r.yaml',
      renderedLine: 3,
      renderedText: rendered,
      templatePath: '/t.tmpl',
      templateText: template,
    });
    // The substring "approve_USDC: " is unique in rendered (appears only on line 3)
    // and is unique in template too (template line 3, 1-indexed).
    expect(r.line).toBe(3);
    expect(r.file).toBe('/t.tmpl');
    expect(r.note).toBeUndefined();
  });

  it('T7-2: ambiguous loop output -> fallback', () => {
    const template = ['{% for x in xs %}', '  - "0xPLACEHOLDER"', '{% endfor %}'].join('\n');
    const rendered = [
      '  - "0x1111111111111111111111111111111111111111"',
      '  - "0x1111111111111111111111111111111111111111"',
      '  - "0x1111111111111111111111111111111111111111"',
    ].join('\n');
    const r = templateLineGuess({
      renderedPath: '/r.yaml',
      renderedLine: 2,
      renderedText: rendered,
      templatePath: '/t.tmpl',
      templateText: template,
    });
    expect(r.line).toBeNull();
    expect(r.note).toContain('could not uniquely map');
  });

  it('T7-3: no template match -> fallback', () => {
    const template = '{{ x }}{{ y }}\n'; // pure interpolation
    const rendered = 'aaa bbb\n'; // rendered content not literally in template
    const r = templateLineGuess({
      renderedPath: '/r.yaml',
      renderedLine: 1,
      renderedText: rendered,
      templatePath: '/t.tmpl',
      templateText: template,
    });
    expect(r.line).toBeNull();
  });

  it('T7-4: empty rendered line -> fallback', () => {
    const r = templateLineGuess({
      renderedPath: '/r.yaml',
      renderedLine: 1,
      renderedText: '\n',
      templatePath: '/t.tmpl',
      templateText: 'x\n',
    });
    expect(r.line).toBeNull();
  });

  it('T7-5: substring length floor — short rendered line below 8 chars -> fallback', () => {
    const r = templateLineGuess({
      renderedPath: '/r.yaml',
      renderedLine: 1,
      renderedText: 'name:\n',
      templatePath: '/t.tmpl',
      templateText: 'name:\n',
    });
    // Rendered line has 5 chars after trim; below default floor of 8.
    expect(r.line).toBeNull();
  });

  it('T7-6: tunable floor — passing floor=4 makes T7-5 succeed', () => {
    const r = templateLineGuess({
      renderedPath: '/r.yaml',
      renderedLine: 1,
      renderedText: 'name:\n',
      templatePath: '/t.tmpl',
      templateText: 'name:\n',
      floor: 4,
    });
    expect(r.line).toBe(1);
  });
});
