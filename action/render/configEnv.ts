import nunjucks from 'nunjucks';
import { keccak } from './keccakFilter';

export interface ConfigEnvOpts {
  /** Search paths in order. First match wins. */
  searchPaths: string[];
  /** Merged alias registry, exposed as `aliases` global. */
  aliases: Record<string, unknown>;
}

/**
 * Build a Nunjucks environment for rendering DEPLOYMENT configs and TEMPLATES.
 *
 * Search-path order is `[deploymentConfigDir, ...extraTemplateDirs, curatedTemplatesDir]`
 * — deployment-config-dir first; curated last. The loader uses `noCache: true` so tests
 * are order-independent (otherwise the loader caches templates by filename).
 */
export function makeConfigEnv(opts: ConfigEnvOpts): nunjucks.Environment {
  const loader = new nunjucks.FileSystemLoader(opts.searchPaths, { noCache: true });
  const env = new nunjucks.Environment(loader, { throwOnUndefined: true });
  env.addGlobal('aliases', opts.aliases);
  env.addFilter('keccak', keccak);
  return env;
}
