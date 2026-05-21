import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseAbiItem, isAddress } from 'viem';
import nunjucks from 'nunjucks';
import { parseDocument } from 'yaml';
import { Command } from 'commander';
import pkg from './package.json' with { type: 'json' };

describe('phase 1 scaffold smoke', () => {
  it('T1-1: bun version is >= 1.3', () => {
    const version = execSync('bun --version', { encoding: 'utf8' }).trim();
    expect(version).toMatch(/^1\.[3-9]/);
  });
  it('zod imports', () => {
    expect(typeof z.object).toBe('function');
  });
  it('viem imports', () => {
    expect(typeof parseAbiItem).toBe('function');
    expect(typeof isAddress).toBe('function');
  });
  it('nunjucks imports', () => {
    expect(typeof nunjucks.Environment).toBe('function');
  });
  it('eemeli/yaml imports', () => {
    expect(typeof parseDocument).toBe('function');
  });
  it('commander imports', () => {
    expect(typeof Command).toBe('function');
  });
  it('every package.json script has a non-empty value', () => {
    const required = ['test', 'lint', 'format', 'format-check', 'typecheck', 'audit'];
    for (const k of required) {
      expect((pkg.scripts as Record<string, string>)[k]).toBeTruthy();
    }
  });
});
