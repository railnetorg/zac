import type nunjucks from 'nunjucks';
import { ZacError } from '../errors';

export interface RenderTemplateOpts {
  /** Path resolvable via the env's loader (relative to a search path, or absolute). */
  templatePath: string;
  /** The deployment config entry's `params`, exposed as additional render context. */
  params: Record<string, unknown>;
}

/**
 * Render a template via the env's loader (so includes/imports resolve). The env's
 * `aliases` global is already bound; `params` is the only EXTRA context (§9.58).
 */
export function renderTemplate(env: nunjucks.Environment, opts: RenderTemplateOpts): string {
  try {
    return env.render(opts.templatePath, opts.params);
  } catch (e) {
    throw new ZacError({
      phase: 'render',
      message: `nunjucks render failed for ${opts.templatePath}: ${(e as Error).message}`,
      sourceLocation: { file: opts.templatePath },
    });
  }
}
