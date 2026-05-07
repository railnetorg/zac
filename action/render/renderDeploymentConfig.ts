import { readFileSync } from 'node:fs';
import type nunjucks from 'nunjucks';
import { ZacError } from '../errors';

/**
 * Render a deployment config file with the env. The deployment config sees the
 * `aliases` global ONLY (no extra context — §9.58).
 */
export function renderDeploymentConfig(env: nunjucks.Environment, configPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new ZacError({
      phase: 'render',
      message: `failed to read deployment config: ${configPath}`,
      sourceLocation: { file: configPath },
    });
  }

  try {
    return env.renderString(raw, {});
  } catch (e) {
    throw new ZacError({
      phase: 'render',
      message: `nunjucks render failed for ${configPath}: ${(e as Error).message}`,
      sourceLocation: { file: configPath },
    });
  }
}
