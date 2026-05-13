import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ZacError } from './errors';

/** A source config file: ends in `.zac.yaml`. */
const ZAC_SOURCE_SUFFIX = '.zac.yaml';
/** A plan file: ends in `.plan.json`. */
const PLAN_SUFFIX = '.plan.json';
/** A generated YAML file: ends in `.yaml` but NOT `.zac.yaml`. */
function isYamlNotSource(name: string): boolean {
  return name.endsWith('.yaml') && !name.endsWith(ZAC_SOURCE_SUFFIX);
}

/** Strip `.zac.yaml` from a source path → its alongside generated path. */
export function generatedPathFor(sourcePath: string): string {
  if (!sourcePath.endsWith(ZAC_SOURCE_SUFFIX)) {
    throw new ZacError({
      phase: 'load',
      message: `expected a source file ending in ${ZAC_SOURCE_SUFFIX}: ${sourcePath}`,
    });
  }
  return sourcePath.slice(0, -ZAC_SOURCE_SUFFIX.length) + '.yaml';
}

/** Given a generated path (`<stem>.yaml`), return its sibling source path (`<stem>.zac.yaml`). */
export function sourcePathFor(generatedPath: string): string {
  if (!generatedPath.endsWith('.yaml') || generatedPath.endsWith(ZAC_SOURCE_SUFFIX)) {
    throw new ZacError({
      phase: 'load',
      message: `expected a generated file ending in .yaml (not ${ZAC_SOURCE_SUFFIX}): ${generatedPath}`,
    });
  }
  return generatedPath.slice(0, -'.yaml'.length) + ZAC_SOURCE_SUFFIX;
}

/** Given a generated path (`<stem>.yaml`), return its sibling plan path (`<stem>.plan.json`). */
export function planPathFor(generatedPath: string): string {
  if (!generatedPath.endsWith('.yaml') || generatedPath.endsWith(ZAC_SOURCE_SUFFIX)) {
    throw new ZacError({
      phase: 'load',
      message: `expected a generated file ending in .yaml (not ${ZAC_SOURCE_SUFFIX}): ${generatedPath}`,
    });
  }
  return generatedPath.slice(0, -'.yaml'.length) + PLAN_SUFFIX;
}

function toAbs(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

function ensureExists(p: string): void {
  if (!existsSync(p)) {
    throw new ZacError({
      phase: 'load',
      message: `path not found: ${p}`,
    });
  }
}

function walk(dir: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

/**
 * Discover ZAC source configs (`*.zac.yaml`) under `path`.
 * - If `path` is a file: must end in `.zac.yaml`; returns `[path]`.
 * - If `path` is a directory: walks recursively, returns every `*.zac.yaml`.
 * Returned paths are absolute.
 */
export function findZacSources(path: string): string[] {
  const abs = toAbs(path);
  ensureExists(abs);
  const st = statSync(abs);
  if (st.isFile()) {
    if (!abs.endsWith(ZAC_SOURCE_SUFFIX)) {
      throw new ZacError({
        phase: 'load',
        message: `expected a source file ending in ${ZAC_SOURCE_SUFFIX}: ${abs}`,
      });
    }
    return [abs];
  }
  const found: string[] = [];
  walk(abs, (p) => {
    if (p.endsWith(ZAC_SOURCE_SUFFIX)) found.push(p);
  });
  found.sort();
  return found;
}

/**
 * Discover generated configs under `path`. A generated config is a `*.yaml`
 * file that has a sibling source `*.zac.yaml` of the same stem.
 * - If `path` is a file: must end in `.yaml` and NOT `.zac.yaml`; returns `[path]`.
 *   (No sibling check in file mode — caller is asking explicitly for this file.)
 * - If `path` is a directory: walks recursively; returns every `*.yaml` with a
 *   matching sibling `.zac.yaml`.
 * Returned paths are absolute.
 */
export function findGeneratedConfigs(path: string): string[] {
  const abs = toAbs(path);
  ensureExists(abs);
  const st = statSync(abs);
  if (st.isFile()) {
    if (!isYamlNotSource(basename(abs))) {
      throw new ZacError({
        phase: 'load',
        message: `expected a generated file ending in .yaml (not ${ZAC_SOURCE_SUFFIX}): ${abs}`,
      });
    }
    return [abs];
  }
  const found: string[] = [];
  walk(abs, (p) => {
    if (!isYamlNotSource(basename(p))) return;
    const sibling = sourcePathFor(p);
    if (existsSync(sibling)) found.push(p);
  });
  found.sort();
  return found;
}

/**
 * Discover plan files (`*.plan.json`) under `path`.
 * - If `path` is a file: must end in `.plan.json`; returns `[path]`.
 * - If `path` is a directory: walks recursively, returns every `*.plan.json`.
 * Returned paths are absolute.
 */
export function findPlans(path: string): string[] {
  const abs = toAbs(path);
  ensureExists(abs);
  const st = statSync(abs);
  if (st.isFile()) {
    if (!abs.endsWith(PLAN_SUFFIX)) {
      throw new ZacError({
        phase: 'load',
        message: `expected a plan file ending in ${PLAN_SUFFIX}: ${abs}`,
      });
    }
    return [abs];
  }
  const found: string[] = [];
  walk(abs, (p) => {
    if (p.endsWith(PLAN_SUFFIX)) found.push(p);
  });
  found.sort();
  return found;
}

// Re-export the suffix constants for callers that want to check or label.
export { ZAC_SOURCE_SUFFIX, PLAN_SUFFIX };
