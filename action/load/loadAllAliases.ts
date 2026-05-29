import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { ZacError } from '../errors';
import { makeAliasEnv } from './aliasEnv';
import { loadAliasFile } from './loadAliasFile';
import { mergeGlobalNetwork, mergeNamespace } from './mergeAliases';

export interface LoadAllAliasesOpts {
  configPath: string;
  network: string;
}

interface RootConfig {
  aliases?: Record<string, Record<string, string | string[]> | undefined>;
}

export interface AliasRegistry {
  merged: Record<string, unknown>;
}

export function loadAllAliases(opts: LoadAllAliasesOpts): AliasRegistry {
  const cfgRaw = readFileSync(opts.configPath, 'utf8');
  const cfgDoc = parseDocument(cfgRaw);
  if (cfgDoc.errors.length > 0) {
    throw new ZacError({
      phase: 'load',
      message: `YAML parse failed in ${opts.configPath}: ${cfgDoc.errors[0]!.message}`,
      sourceLocation: { file: opts.configPath },
    });
  }
  const cfg = (cfgDoc.toJSON() ?? {}) as RootConfig;
  const aliases = cfg.aliases ?? {};
  const globalSection = aliases.global ?? {};
  const networkSection = aliases[opts.network] ?? {};

  const env = makeAliasEnv();
  const cfgDir = dirname(opts.configPath);

  const allNamespaces = new Set([...Object.keys(globalSection), ...Object.keys(networkSection)]);

  const merged: Record<string, unknown> = {};
  for (const namespace of allNamespaces) {
    const globalPaths = toArray(globalSection[namespace]);
    const networkPaths = toArray(networkSection[namespace]);

    const globalFiles = globalPaths.map((p) => loadAliasFile(env, resolveRel(cfgDir, p)));
    const networkFiles = networkPaths.map((p) => loadAliasFile(env, resolveRel(cfgDir, p)));

    const globalData = mergeNamespace({ namespace, files: globalFiles });
    const networkData = mergeNamespace({ namespace, files: networkFiles });

    merged[namespace] = mergeGlobalNetwork({
      namespace,
      globalData,
      networkData,
      globalSource: globalPaths.join(',') || '<none>',
      networkSource: networkPaths.join(',') || '<none>',
    });
  }

  // Auto-inject `aliases.ZERO` AFTER the namespace-merge loop so it is
  // non-overridable: users writing `{{ aliases.ZERO }}` in templates (e.g.
  // `safe.yaml: guard: {{ aliases.ZERO }}` to mean "skip") always get the
  // canonical zero-address constant regardless of any user-authored
  // `aliases.global.ZERO` entry.
  merged['ZERO'] = '0x0000000000000000000000000000000000000000';

  return { merged };
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function resolveRel(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}
