import { readFileSync } from 'node:fs';
import type nunjucks from 'nunjucks';
import { parseDocument } from 'yaml';
import { ZacError } from '../errors';

export interface AliasFile {
  path: string;
  data: unknown;
}

/** Render with aliasEnv (empty context), then YAML-parse. */
export function loadAliasFile(env: nunjucks.Environment, path: string): AliasFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ZacError({
      phase: 'load',
      message: `failed to read alias file: ${path}`,
      sourceLocation: { file: path },
    });
  }

  let rendered: string;
  try {
    rendered = env.renderString(raw, {});
  } catch (e) {
    throw new ZacError({
      phase: 'load',
      message: `nunjucks render failed for ${path}: ${(e as Error).message}`,
      sourceLocation: { file: path },
    });
  }

  const doc = parseDocument(rendered);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new ZacError({
      phase: 'load',
      message: `YAML parse failed in ${path}: ${first.message}`,
      sourceLocation: { file: path },
    });
  }

  return { path, data: doc.toJSON() ?? {} };
}
