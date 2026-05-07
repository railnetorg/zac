import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ZacError } from '../errors';

export interface FindConfigOpts {
  override?: string;
  startDir: string;
}

const CONFIG_NAME = 'config.yaml';

/** Walk up from startDir until config.yaml is found; stop at .git/ boundary or filesystem root. */
export function findConfig(opts: FindConfigOpts): string {
  if (opts.override !== undefined) {
    const p = isAbsolute(opts.override) ? opts.override : resolve(opts.override);
    if (!existsSync(p)) {
      throw new ZacError({
        phase: 'load',
        message: `--config path not found: ${p}`,
      });
    }
    return p;
  }

  let dir = resolve(opts.startDir);
  while (true) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
    const gitMarker = join(dir, '.git');
    const reachedRepoBoundary = existsSync(gitMarker);
    const parent = dirname(dir);
    if (reachedRepoBoundary || parent === dir) {
      throw new ZacError({
        phase: 'load',
        message: `config.yaml not found walking up from ${opts.startDir}; stopped at ${dir}`,
      });
    }
    dir = parent;
  }
}
