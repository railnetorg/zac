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
/** Per-safe-dir Safe-level config file name (sibling of `.zac.yaml` files). */
const SAFE_CONFIG_FILE = 'safe.yaml';

/** Path helper: `<safeDir>/safe.yaml`. */
export function safeConfigPathFor(dirPath: string): string {
  return join(dirPath, SAFE_CONFIG_FILE);
}
/** A generated YAML file: ends in `.yaml` but NOT `.zac.yaml`. */
function isYamlNotSource(name: string): boolean {
  return name.endsWith('.yaml') && !name.endsWith(ZAC_SOURCE_SUFFIX);
}

/** Match a 0x-prefixed 40-hex-char address dir name (case-insensitive). */
const ADDRESS_DIR_RE = /^0x[0-9a-fA-F]{40}$/;

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

/**
 * Plan file path for a whole safe-dir (per-modifier plan):
 * `<safeDir.dirPath>/<safeAddress lowercase>.plan.json`. Each safe-dir
 * produces exactly one plan file via the per-modifier `planApply` path.
 */
export function safeDirPlanPathFor(safeDir: { dirPath: string; safeAddress: string }): string {
  return join(safeDir.dirPath, safeDir.safeAddress.toLowerCase() + PLAN_SUFFIX);
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
 * `<network>/<safe-address>/<name>.zac.yaml` convention.
 */
function layoutError(sourcePath: string): never {
  throw new ZacError({
    phase: 'validate',
    message: `expected <network>/<safe-address>/<name>.zac.yaml layout; got ${sourcePath} — move into a 0x-prefixed dir whose name matches safe_address`,
  });
}

/**
 * Validate the parent dir is a 0x-prefixed 40-hex-char address and the
 * grandparent is a known network directory. Returns the parent dir's
 * absolute path on success. Throws `ZacError(phase='validate')` otherwise.
 */
function validateSourcePathLayout(sourcePath: string): { safeDir: string; network: string } {
  const parentDir = dirname(sourcePath);
  const parentName = basename(parentDir);
  if (!ADDRESS_DIR_RE.test(parentName)) {
    layoutError(sourcePath);
  }
  const grandparentName = basename(dirname(parentDir));
  if (!isKnownNetworkDirectory(grandparentName)) {
    throw new ZacError({
      phase: 'validate',
      message: `unknown network directory '${grandparentName}' for ${sourcePath}; supported: [${supportedNetworkDirectories().join(', ')}]`,
    });
  }
  return { safeDir: parentDir, network: grandparentName };
}

/**
 * Discover ZAC source configs (`*.zac.yaml`) under `path`.
 * - If `path` is a file: must end in `.zac.yaml`; returns `[path]`.
 * - If `path` is a directory: walks recursively, returns every `*.zac.yaml`.
 * Returned paths are absolute. Every returned path passes the strict
 * `<network>/<safe-address>/<name>.zac.yaml` layout check.
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
    if (p.endsWith(ZAC_SOURCE_SUFFIX)) found.push(p);
  });
  for (const p of found) validateSourcePathLayout(p);
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
 * Returned paths are absolute. Layout (`<network>/<safe-address>/<stem>.yaml`)
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
    const sibling = sourcePathFor(p);
    if (existsSync(sibling)) found.push(p);
  });
  for (const p of found) validateSourcePathLayout(sourcePathFor(p));
  found.sort();
  return found;
}

/**
 * Validate the PATH layout (`<network>/<safeAddress>/safe.yaml`) of a
 * `safe.yaml` file: parent must be a 0x-prefixed 40-hex address dir, and
 * grandparent must be a known network directory. Returns the parsed
 * `{network, safeAddress}` on success. Throws `ZacError(phase='validate')`
 * otherwise. Does NOT read file contents — content validation lives in
 * `validate/safeConfigSchema.ts`.
 */
export function validateSafeYamlLayout(safeYamlPath: string): {
  network: string;
  safeAddress: string;
} {
  if (basename(safeYamlPath) !== SAFE_CONFIG_FILE) {
    throw new ZacError({
      phase: 'validate',
      message: `expected <network>/<safe-address>/${SAFE_CONFIG_FILE} layout; got ${safeYamlPath} — file must be named '${SAFE_CONFIG_FILE}'`,
    });
  }
  const parentDir = dirname(safeYamlPath);
  const parentName = basename(parentDir);
  if (!ADDRESS_DIR_RE.test(parentName)) {
    throw new ZacError({
      phase: 'validate',
      message: `expected <network>/<safe-address>/${SAFE_CONFIG_FILE} layout; got ${safeYamlPath} — parent dir must be a 0x-prefixed address`,
    });
  }
  const grandparentName = basename(dirname(parentDir));
  if (!isKnownNetworkDirectory(grandparentName)) {
    throw new ZacError({
      phase: 'validate',
      message: `unknown network directory '${grandparentName}' for ${safeYamlPath}; supported: [${supportedNetworkDirectories().join(', ')}]`,
    });
  }
  return { network: grandparentName, safeAddress: parentName.toLowerCase() };
}

/**
 * Discover `safe.yaml` files under `path`.
 * - If `path` is a file: must be named `safe.yaml`; returns `[path]`.
 * - If `path` is a directory: walks recursively, returns every `safe.yaml`.
 * Returned paths are absolute. Every returned path passes the strict
 * `<network>/<safe-address>/safe.yaml` layout check.
 */
export function findSafeYamls(path: string): string[] {
  const abs = toAbs(path);
  ensureExists(abs);
  const st = statSync(abs);
  if (st.isFile()) {
    if (basename(abs) !== SAFE_CONFIG_FILE) {
      throw new ZacError({
        phase: 'load',
        message: `expected a ${SAFE_CONFIG_FILE} file: ${abs}`,
      });
    }
    validateSafeYamlLayout(abs);
    return [abs];
  }
  const found: string[] = [];
  walk(abs, (p) => {
    if (basename(p) === SAFE_CONFIG_FILE) found.push(p);
  });
  for (const p of found) validateSafeYamlLayout(p);
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

/**
 * A safe-dir grouping: one `<network>/<safe-address>/` directory containing
 * EITHER one-or-more sibling `.zac.yaml` files (roles-managed safe-dir)
 * OR a `safe.yaml` file (Safe-level-managed safe-dir) OR both.
 *
 * `sources` are absolute paths to the `.zac.yaml` files (the lookup unit
 * for `runPlanForSafeDir`); empty array in safe-only mode. `safeAddress`
 * is the lowercased dir name (matching the layout convention); `chainId`
 * comes from the network table; both are cross-checked against the
 * rendered `.yaml` bodies when sources exist. `modifierAddress` is the
 * `roles_modifier_address` from the rendered YAML bodies (agreed across
 * siblings) and is `undefined` for safe-only safe-dirs (no `.zac.yaml`).
 * `safeConfigPath` is the absolute path to the dir's `safe.yaml` when
 * present; `undefined` for role-only safe-dirs.
 */
export interface SafeDir {
  dirPath: string;
  network: string;
  chainId: number;
  /** Lowercased 0x-prefixed 40-hex address. */
  safeAddress: `0x${string}`;
  /**
   * Lowercased 0x-prefixed 40-hex address — agreed across all `sources`.
   * Undefined in safe-only mode (no `.zac.yaml` siblings).
   */
  modifierAddress: `0x${string}` | undefined;
  sources: string[];
  /** Absolute path to the dir's `safe.yaml` when present; undefined otherwise. */
  safeConfigPath: string | undefined;
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
 *   safe-dir for that file's parent.
 * - If `path` is a directory, walks recursively and groups every `.zac.yaml`
 *   under its `<network>/<safe-address>/` parent.
 *
 * Layout validation is strict — every source must live at
 * `<network>/<safe-address>/<name>.zac.yaml`. Each source's generated
 * sibling `.yaml` must exist (run `zac generate` first); we read it to
 * extract `chain_id`, `safe_address`, `roles_modifier_address`. All sources
 * within a safe-dir must agree on those three values, and the rendered
 * `safe_address` must match the parent dir name (case-insensitive).
 *
 * Returned safe-dirs are ordered deterministically by `dirPath`; `sources`
 * within each safe-dir are sorted by path.
 */
export function findSafeDirs(path: string, opts: FindSafeDirsOpts = {}): SafeDir[] {
  const parse = opts.parseGenerated ?? parseGenerated;

  // Probe both source-types under `path`. `findZacSources` and
  // `findSafeYamls` each accept `path` as either a file or a directory;
  // in file-mode the OTHER probe is skipped (a `.zac.yaml` file doesn't
  // contain `safe.yaml`s and vice-versa).
  const abs = toAbs(path);
  ensureExists(abs);
  const st = statSync(abs);
  const isFile = st.isFile();
  const isSafeYamlFile = isFile && basename(abs) === SAFE_CONFIG_FILE;
  const isZacSourceFile = isFile && abs.endsWith(ZAC_SOURCE_SUFFIX);

  const zacSources: string[] = isSafeYamlFile ? [] : findZacSources(path);
  const safeYamls: string[] = isZacSourceFile ? [] : findSafeYamls(path);

  // Group `.zac.yaml` sources by their parent dir.
  const byDir = new Map<string, { sources: string[]; safeYamlPath: string | undefined }>();
  for (const src of zacSources) {
    const dir = dirname(src);
    const entry = byDir.get(dir);
    if (entry === undefined) byDir.set(dir, { sources: [src], safeYamlPath: undefined });
    else entry.sources.push(src);
  }
  // Union in `safe.yaml`s: attach to an existing entry or create a new
  // safe-only entry.
  for (const sy of safeYamls) {
    const dir = dirname(sy);
    const entry = byDir.get(dir);
    if (entry === undefined) byDir.set(dir, { sources: [], safeYamlPath: sy });
    else entry.safeYamlPath = sy;
  }

  const dirs = [...byDir.keys()].sort();
  const out: SafeDir[] = [];
  for (const dir of dirs) {
    const entry = byDir.get(dir)!;
    const dirSources = entry.sources.slice().sort();
    out.push(buildSafeDir(dir, dirSources, entry.safeYamlPath, parse));
  }
  return out;
}

function buildSafeDir(
  dirPath: string,
  sources: string[],
  safeYamlPath: string | undefined,
  parse: ParseGeneratedFn,
): SafeDir {
  // Safe-only branch — no `.zac.yaml` siblings. Take path-layout from the
  // safe.yaml itself (which is guaranteed present by findSafeDirs union
  // logic when sources is empty). Must run BEFORE `validateSourcePathLayout`
  // since the latter dereferences `sources[0]!` which is undefined here.
  if (sources.length === 0) {
    if (safeYamlPath === undefined) {
      throw new ZacError({
        phase: 'validate',
        message: `internal: buildSafeDir called with no sources and no safe.yaml for ${dirPath}`,
      });
    }
    const { network, safeAddress } = validateSafeYamlLayout(safeYamlPath);
    const chainId = networkForDirectory(network);
    if (chainId === null) {
      throw new ZacError({
        phase: 'validate',
        message: `unknown network directory: ${network}`,
      });
    }
    return {
      dirPath,
      network,
      chainId,
      safeAddress: safeAddress as `0x${string}`,
      modifierAddress: undefined,
      sources: [],
      safeConfigPath: safeYamlPath,
    };
  }

  // Role+safe path (sources.length > 0): unchanged.
  // Layout — every source in this dir must share the same parent (it does by
  // construction) and that parent must be a 0x-addr under a known network.
  const { network } = validateSourcePathLayout(sources[0]!);
  const dirAddress = basename(dirPath).toLowerCase() as `0x${string}`;
  const expectedChainId = networkForDirectory(network);
  if (expectedChainId === null) {
    throw new ZacError({
      phase: 'validate',
      message: `internal: networkForDirectory returned null for '${network}'`,
    });
  }

  // Parse every source's generated sibling to extract deployment fields.
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

  // Body match: every YAML's safe_address must match the parent dir name.
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
    safeConfigPath: safeYamlPath,
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

// Re-export the suffix constants for callers that want to check or label.
export { ZAC_SOURCE_SUFFIX, PLAN_SUFFIX };
