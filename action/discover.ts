import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ZacError } from './errors';
import {
  isKnownNetworkDirectory,
  networkForDirectory,
  supportedNetworkDirectories,
} from './load/networkTable';
import { parseGenerated, type Generated } from './apply/parseGenerated';
import type { Plan } from './apply/planSchema';

/** A source config file: ends in `.zac.yaml`. */
const ZAC_SOURCE_SUFFIX = '.zac.yaml';
/** A plan file: ends in `.plan.json`. */
const PLAN_SUFFIX = '.plan.json';
/** Per-safe subfolder for source `.zac.yaml` files. */
const SOURCE_SUBDIR = 'config';
/** Per-safe subfolder for generated `.yaml` files. */
const GENERATED_SUBDIR = 'zac-out';
/** Per-safe subfolder for `.plan.json` files (both per-file and aggregated). */
const PLAN_SUBDIR = 'txs';
/** A generated YAML file: ends in `.yaml` but NOT `.zac.yaml`. */
function isYamlNotSource(name: string): boolean {
  return name.endsWith('.yaml') && !name.endsWith(ZAC_SOURCE_SUFFIX);
}

/** Match a 0x-prefixed 40-hex-char address dir name (case-insensitive). */
const ADDRESS_DIR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Translate a source path `<safe>/config/<stem>.zac.yaml` to its companion
 * generated path `<safe>/zac-out/<stem>.yaml`.
 */
export function generatedPathFor(sourcePath: string): string {
  if (!sourcePath.endsWith(ZAC_SOURCE_SUFFIX)) {
    throw new ZacError({
      phase: 'load',
      message: `expected a source file ending in ${ZAC_SOURCE_SUFFIX}: ${sourcePath}`,
    });
  }
  const stem = basename(sourcePath).slice(0, -ZAC_SOURCE_SUFFIX.length);
  const safeDir = dirname(dirname(sourcePath));
  return join(safeDir, GENERATED_SUBDIR, `${stem}.yaml`);
}

/**
 * Translate a generated path `<safe>/zac-out/<stem>.yaml` to its companion
 * source path `<safe>/config/<stem>.zac.yaml`.
 */
export function sourcePathFor(generatedPath: string): string {
  if (!generatedPath.endsWith('.yaml') || generatedPath.endsWith(ZAC_SOURCE_SUFFIX)) {
    throw new ZacError({
      phase: 'load',
      message: `expected a generated file ending in .yaml (not ${ZAC_SOURCE_SUFFIX}): ${generatedPath}`,
    });
  }
  const stem = basename(generatedPath).slice(0, -'.yaml'.length);
  const safeDir = dirname(dirname(generatedPath));
  return join(safeDir, SOURCE_SUBDIR, `${stem}${ZAC_SOURCE_SUFFIX}`);
}

/**
 * Translate a generated path `<safe>/zac-out/<stem>.yaml` to its companion
 * plan path `<safe>/txs/<stem>.plan.json`.
 */
export function planPathFor(generatedPath: string): string {
  if (!generatedPath.endsWith('.yaml') || generatedPath.endsWith(ZAC_SOURCE_SUFFIX)) {
    throw new ZacError({
      phase: 'load',
      message: `expected a generated file ending in .yaml (not ${ZAC_SOURCE_SUFFIX}): ${generatedPath}`,
    });
  }
  const stem = basename(generatedPath).slice(0, -'.yaml'.length);
  const safeDir = dirname(dirname(generatedPath));
  return join(safeDir, PLAN_SUBDIR, `${stem}${PLAN_SUFFIX}`);
}

/**
 * Plan file path for a whole safe-dir (per-modifier plan):
 * `<safeDir.dirPath>/txs/<safeAddress lowercase>.plan.json`. Each safe-dir
 * produces exactly one plan file via the per-modifier `planApply` path.
 */
export function safeDirPlanPathFor(safeDir: { dirPath: string; safeAddress: string }): string {
  return join(safeDir.dirPath, PLAN_SUBDIR, safeDir.safeAddress.toLowerCase() + PLAN_SUFFIX);
}

/**
 * Absolute path of the safe-address directory for a source path
 * `<network>/<safe>/config/<name>.zac.yaml`. The safe-address dir is the
 * GRANDPARENT of the source (the `config/` subdir is between).
 */
export function safeDirFromSource(sourcePath: string): string {
  return dirname(dirname(sourcePath));
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
 * Layout error message for sources outside the
 * `<network>/<safe-address>/config/<name>.zac.yaml` convention.
 */
function layoutError(sourcePath: string): never {
  throw new ZacError({
    phase: 'validate',
    message: `expected <network>/<safe-address>/config/<name>.zac.yaml layout; got ${sourcePath} — sources must live in a \`config/\` subdir under a 0x-prefixed safe-address dir`,
  });
}

/**
 * Validate the layout walking up from a `.zac.yaml` source:
 *   immediate parent must be `config/`
 *   grandparent must be a 0x-prefixed 40-hex address dir
 *   great-grandparent must be a known network dir
 * Returns the safe-address dir's absolute path and the network name on
 * success. Throws `ZacError(phase='validate')` otherwise.
 */
function validateSourcePathLayout(sourcePath: string): { safeDir: string; network: string } {
  const configDir = dirname(sourcePath);
  if (basename(configDir) !== SOURCE_SUBDIR) {
    layoutError(sourcePath);
  }
  const safeDir = dirname(configDir);
  const safeDirName = basename(safeDir);
  if (!ADDRESS_DIR_RE.test(safeDirName)) {
    layoutError(sourcePath);
  }
  const networkName = basename(dirname(safeDir));
  if (!isKnownNetworkDirectory(networkName)) {
    throw new ZacError({
      phase: 'validate',
      message: `unknown network directory '${networkName}' for ${sourcePath}; supported: [${supportedNetworkDirectories().join(', ')}]`,
    });
  }
  return { safeDir, network: networkName };
}

/**
 * Discover ZAC source configs (`*.zac.yaml`) under `path`.
 * - If `path` is a file: must end in `.zac.yaml`; returns `[path]` (strict
 *   layout check: must sit at `<network>/<safe-address>/config/<name>.zac.yaml`).
 * - If `path` is a directory: walks recursively; returns every `*.zac.yaml`
 *   under a `config/` parent directory. Sources NOT under a `config/`
 *   parent are silently skipped (irrelevant to ZAC).
 * Returned paths are absolute. Every returned path passes the strict
 * `<network>/<safe-address>/config/<name>.zac.yaml` layout check.
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
    validateSourcePathLayout(abs);
    return [abs];
  }
  const found: string[] = [];
  walk(abs, (p) => {
    if (!p.endsWith(ZAC_SOURCE_SUFFIX)) return;
    // Only surface sources living under a `config/` subdir. Anything else
    // is silently skipped at directory-walk time (it's not addressed to ZAC).
    if (basename(dirname(p)) !== SOURCE_SUBDIR) return;
    found.push(p);
  });
  for (const p of found) validateSourcePathLayout(p);
  found.sort();
  return found;
}

/**
 * Discover generated configs under `path`. A generated config is a `*.yaml`
 * file that lives under a `zac-out/` subdir and has a sibling source
 * `../config/<stem>.zac.yaml`.
 * - If `path` is a file: must end in `.yaml` and NOT `.zac.yaml`; returns `[path]`.
 *   (No sibling check in file mode — caller is asking explicitly for this file.)
 * - If `path` is a directory: walks recursively; returns every `*.yaml`
 *   under a `zac-out/` parent that has a matching `../config/<stem>.zac.yaml`.
 * Returned paths are absolute. Layout (`<network>/<safe-address>/zac-out/<stem>.yaml`)
 * is enforced for every returned path.
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
    validateSourcePathLayout(sourcePathFor(abs));
    return [abs];
  }
  const found: string[] = [];
  walk(abs, (p) => {
    if (!isYamlNotSource(basename(p))) return;
    // Only surface generated files living under a `zac-out/` subdir.
    if (basename(dirname(p)) !== GENERATED_SUBDIR) return;
    const sibling = sourcePathFor(p);
    if (existsSync(sibling)) found.push(p);
  });
  for (const p of found) validateSourcePathLayout(sourcePathFor(p));
  found.sort();
  return found;
}

/**
 * Discover plan files (`*.plan.json`) under `path`.
 * - If `path` is a file: must end in `.plan.json`; returns `[path]`.
 * - If `path` is a directory: walks recursively; returns every `*.plan.json`
 *   under a `txs/` parent. Plans NOT under a `txs/` parent are silently
 *   skipped (irrelevant to ZAC's submit flow).
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
    if (!p.endsWith(PLAN_SUFFIX)) return;
    if (basename(dirname(p)) !== PLAN_SUBDIR) return;
    found.push(p);
  });
  found.sort();
  return found;
}

/**
 * A safe-dir grouping: one `<network>/<safe-address>/` directory containing
 * a `config/` subdir with one or more `.zac.yaml` files, all sharing the
 * same `(chain_id, safe_address, roles_modifier_address)`.
 *
 * `sources` are absolute paths to the `.zac.yaml` files (the lookup unit for
 * `runPlanForSafeDir`). `safeAddress` is the lowercased dir name (matching
 * the layout convention); `chainId` comes from the network table; both are
 * cross-checked against the rendered `.yaml` bodies. `modifierAddress`
 * comes from the rendered YAML bodies (which must agree across siblings).
 *
 * `dirPath` is the SAFE-ADDRESS dir (the grandparent of each `.zac.yaml`),
 * NOT the inner `config/` subdir.
 */
export interface SafeDir {
  dirPath: string;
  network: string;
  chainId: number;
  /** Lowercased 0x-prefixed 40-hex address. */
  safeAddress: `0x${string}`;
  /** Lowercased 0x-prefixed 40-hex address — agreed across all sources. */
  modifierAddress: `0x${string}`;
  sources: string[];
}

interface ParseGeneratedFn {
  (path: string): Generated;
}

export interface FindSafeDirsOpts {
  /** Inject for testability — defaults to `parseGenerated`. */
  parseGenerated?: ParseGeneratedFn;
}

/**
 * Discover safe-dirs under `path`. Used by per-modifier plan/apply flows.
 *
 * - If `path` is a file (must be a `*.zac.yaml`), produces a single-source
 *   safe-dir for that file's GRANDPARENT (the safe-address dir).
 * - If `path` is a directory, walks recursively and groups every `.zac.yaml`
 *   under its `<network>/<safe-address>/config/` parent.
 *
 * Layout validation is strict — every source must live at
 * `<network>/<safe-address>/config/<name>.zac.yaml`. Each source's
 * generated companion at `<safe>/zac-out/<stem>.yaml` must exist (run `zac
 * generate` first); we read it to extract `chain_id`, `safe_address`,
 * `roles_modifier_address`. All sources within a safe-dir must agree on
 * those three values, and the rendered `safe_address` must match the
 * safe-address dir name (case-insensitive).
 *
 * Returned safe-dirs are ordered deterministically by `dirPath`; `sources`
 * within each safe-dir are sorted by path.
 */
export function findSafeDirs(path: string, opts: FindSafeDirsOpts = {}): SafeDir[] {
  const parse = opts.parseGenerated ?? parseGenerated;
  const sources = findZacSources(path);

  // Group by safe-address dir (grandparent of each source).
  const byDir = new Map<string, string[]>();
  for (const src of sources) {
    const dir = safeDirFromSource(src);
    const list = byDir.get(dir);
    if (list === undefined) byDir.set(dir, [src]);
    else list.push(src);
  }

  const dirs = [...byDir.keys()].sort();
  const out: SafeDir[] = [];
  for (const dir of dirs) {
    const dirSources = (byDir.get(dir) ?? []).slice().sort();
    out.push(buildSafeDir(dir, dirSources, parse));
  }
  return out;
}

function buildSafeDir(dirPath: string, sources: string[], parse: ParseGeneratedFn): SafeDir {
  // Layout — every source in this dir must share the same safe-address dir
  // (it does by construction) and that dir must be a 0x-addr under a known
  // network.
  const { network } = validateSourcePathLayout(sources[0]!);
  const dirAddress = basename(dirPath).toLowerCase() as `0x${string}`;
  const expectedChainId = networkForDirectory(network);
  if (expectedChainId === null) {
    throw new ZacError({
      phase: 'validate',
      message: `internal: networkForDirectory returned null for '${network}'`,
    });
  }

  // Parse every source's generated companion to extract deployment fields.
  const parsed = sources.map((src) => {
    const gen = generatedPathFor(src);
    if (!existsSync(gen)) {
      throw new ZacError({
        phase: 'load',
        message: `missing generated config for ${src}; run \`zac generate\` first`,
        sourceLocation: { file: src },
      });
    }
    return { src, gen, generated: parse(gen) };
  });

  // Body match: every YAML's safe_address must match the safe-address dir name.
  for (const { src, generated } of parsed) {
    if (generated.deployment.safe_address.toLowerCase() !== dirAddress) {
      throw new ZacError({
        phase: 'validate',
        message: `safe_address mismatch in ${src}: yaml says ${generated.deployment.safe_address} but parent dir is ${basename(dirPath)} — the dir name must match (case-insensitive) the rendered safe_address`,
        sourceLocation: { file: src },
      });
    }
  }

  // Siblings agree on (chain_id, safe_address, roles_modifier_address).
  const first = parsed[0]!;
  for (const p of parsed) {
    if (p.generated.deployment.chain_id !== first.generated.deployment.chain_id) {
      throw new ZacError({
        phase: 'validate',
        message: `chain_id mismatch across safe-dir ${dirPath}: ${first.src} says ${first.generated.deployment.chain_id} but ${p.src} says ${p.generated.deployment.chain_id}`,
        sourceLocation: { file: p.src },
      });
    }
    if (
      p.generated.deployment.safe_address.toLowerCase() !==
      first.generated.deployment.safe_address.toLowerCase()
    ) {
      throw new ZacError({
        phase: 'validate',
        message: `safe_address mismatch across safe-dir ${dirPath}: ${first.src} says ${first.generated.deployment.safe_address} but ${p.src} says ${p.generated.deployment.safe_address}`,
        sourceLocation: { file: p.src },
      });
    }
    if (
      p.generated.deployment.roles_modifier_address.toLowerCase() !==
      first.generated.deployment.roles_modifier_address.toLowerCase()
    ) {
      throw new ZacError({
        phase: 'validate',
        message: `roles_modifier_address mismatch across safe-dir ${dirPath}: ${first.src} says ${first.generated.deployment.roles_modifier_address} but ${p.src} says ${p.generated.deployment.roles_modifier_address}`,
        sourceLocation: { file: p.src },
      });
    }
  }

  // network table cross-check (mirrors `networkCheck` for the generate path).
  if (first.generated.deployment.chain_id !== expectedChainId) {
    throw new ZacError({
      phase: 'validate',
      message: `directory '${network}' implies chain_id ${expectedChainId} but ${first.src} declares ${first.generated.deployment.chain_id}`,
      sourceLocation: { file: first.src },
    });
  }

  return {
    dirPath,
    network,
    chainId: first.generated.deployment.chain_id,
    safeAddress: dirAddress,
    modifierAddress:
      first.generated.deployment.roles_modifier_address.toLowerCase() as `0x${string}`,
    sources,
  };
}

/**
 * A group of plans sharing the same `(safeAddress, chainId)`. Used by `zac
 * submit` directory-mode to bundle plans into a single Safe transaction.
 */
export interface PlanGroup {
  safeAddress: string;
  chainId: number;
  plans: Plan[];
}

/**
 * Group plans by `(safeAddress, chainId)`. The grouping key is the
 * LOWERCASED safe address — two plans whose `safeAddress` differs only by
 * casing (e.g. EIP-55 checksum vs. all-lowercase dir-name) belong to the
 * same group. Order is deterministic: groups appear in the order their
 * first plan is encountered in the input; plans within a group preserve
 * input order. The group's `safeAddress` is preserved from the first plan
 * encountered (caller decides whether to lowercase downstream).
 */
export function groupPlansBySafe(plans: Plan[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const plan of plans) {
    const key = `${plan.safeAddress.toLowerCase()}@${plan.chainId}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { safeAddress: plan.safeAddress, chainId: plan.chainId, plans: [] };
      groups.set(key, group);
    }
    group.plans.push(plan);
  }
  return [...groups.values()];
}

// Re-export the suffix + subdir constants for callers that want to check or label.
export { ZAC_SOURCE_SUFFIX, PLAN_SUFFIX, SOURCE_SUBDIR, GENERATED_SUBDIR, PLAN_SUBDIR };
