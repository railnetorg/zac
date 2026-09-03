#!/usr/bin/env bun
import { Command } from 'commander';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { ZacError, formatError } from './errors';
import {
  findGeneratedConfigs,
  findPlans,
  findSafeDirs,
  findZacSources,
  generatedPathFor,
  groupPlansBySafe,
  planPathFor,
  safeDirPlanPathFor,
  sourcePathFor,
  type PlanGroup,
  type SafeDir,
} from './discover';
import { runGenerate } from './runGenerate';
import { parseGenerated } from './apply/parseGenerated';
import { readSafeNonce, type ReadSafeNonceFn } from './apply/safeApi';
import type { Plan, SafeTxData } from './apply/planSchema';

declare const Bun: { main: string } | undefined;

interface BunImportMeta extends ImportMeta {
  path?: string;
}

function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  // If the relative path escapes cwd, fall back to absolute.
  return rel.startsWith('..') ? p : rel;
}

/**
 * Lazily load the SDK pieces the diff printer needs (`decodeKey` for
 * roleKey decoding, `rolesAbi` for viem-side calldata decoding). Mirrors
 * the lazy-import pattern in the runners — the SDK module is heavy and
 * pulling it in eagerly slows `--help`.
 */
async function loadDiffSdk(): Promise<{
  decodeKey: (k: string) => string;
  rolesAbi: readonly unknown[];
}> {
  const mod = (await import('zodiac-roles-sdk')) as unknown as {
    decodeKey: (k: string) => string;
    rolesAbi: readonly unknown[];
  };
  return { decodeKey: mod.decodeKey, rolesAbi: mod.rolesAbi };
}

/**
 * The set of role keys declared across every source in a safe-dir. Used
 * by the diff printer in per-safe-dir mode to flag revokes targeting
 * roles that no `.zac.yaml` mentions (those are the "unmentioned" revokes
 * the SDK emits when `--revoke-unmentioned=true`).
 *
 * Parses each source's generated sibling YAML; this is the same parse
 * `runPlanForSafeDir` runs internally but kept here to avoid changing
 * the runner's return signature.
 */
function declaredRoleKeysForSafeDir(sd: SafeDir): Set<string> {
  const out = new Set<string>();
  for (const src of sd.sources) {
    // `findSafeDirs` already validated every source's generated sibling
    // exists and parses — re-parsing here is cheap (one file per source)
    // and avoids threading a new return field through the runners.
    const genPath = src.slice(0, -'.zac.yaml'.length) + '.yaml';
    try {
      const parsed = parseGenerated(genPath);
      for (const key of Object.keys(parsed.roles)) out.add(key);
    } catch {
      // Best-effort: never block the diff print on a parse hiccup.
    }
  }
  return out;
}

/**
 * Build a selector → function-name map from the generated sibling(s) of
 * the given source paths. Used by `printPlanDiff` to annotate
 * `scopeFunction` / `revokeFunction` calls with the user's own function
 * names beyond the built-in ERC20 catalog. Parse failures are skipped
 * silently (the printer falls back to raw hex for unknown selectors).
 */
function buildSelectorMapForSources(
  sources: string[],
  buildMap: typeof import('./apply/buildSelectorMap').buildSelectorMap,
): Record<string, string> {
  const generatedList = [];
  for (const src of sources) {
    try {
      generatedList.push(parseGenerated(generatedPathFor(src)));
    } catch {
      // best-effort
    }
  }
  return buildMap(generatedList);
}

/**
 * Build a `<target>:<selector>` → source-side function-params map from
 * the generated sibling(s) of the given source paths. Used by
 * `printPlanDiff` to expand each planned `scopeFunction` into a foundry-
 * style subtree showing each arg's type, name, and constraint.
 */
function buildFunctionParamMapForSources(
  sources: string[],
  buildMap: typeof import('./apply/buildFunctionParamMap').buildFunctionParamMap,
): Record<string, import('./apply/buildFunctionParamMap').FunctionParams> {
  const generatedList = [];
  for (const src of sources) {
    try {
      generatedList.push(parseGenerated(generatedPathFor(src)));
    } catch {
      // best-effort
    }
  }
  return buildMap(generatedList);
}

/**
 * Build an address → alias-label map for the given source paths. Resolves
 * `config.yaml` from each source's safe-dir and loads the alias registry
 * for the inferred network (`<network>/<safe>/*.zac.yaml`). Sources from
 * different networks merge into one map; per-network labels never clash
 * because addresses are globally unique. Failures (no config, parse
 * error) degrade silently to no labels — never block the diff print.
 */
async function buildAddressLabelMapForSources(
  sources: string[],
  buildMap: typeof import('./apply/buildAddressLabelMap').buildAddressLabelMap,
  loadAllAliases: typeof import('./load/loadAllAliases').loadAllAliases,
  findConfig: typeof import('./load/findConfig').findConfig,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const seenConfigs = new Set<string>();
  for (const src of sources) {
    try {
      const safeDir = dirname(src);
      const network = basename(dirname(safeDir));
      const configPath = findConfig({ startDir: safeDir });
      // Dedupe — multiple sources in the same safe-dir share one config.
      const key = `${configPath}::${network}`;
      if (seenConfigs.has(key)) continue;
      seenConfigs.add(key);
      const aliases = loadAllAliases({ configPath, network });
      const map = buildMap(aliases);
      for (const [addr, label] of Object.entries(map)) {
        if (out[addr] === undefined) out[addr] = label;
      }
    } catch {
      // best-effort
    }
  }
  return out;
}

/** One nested-signer preview row (mirrors `PrintPlanDiffOpts['nestedPreview']`). */
interface NestedPreviewRow {
  child: string;
  label?: string;
  domainHash: string;
  messageHash?: string;
  safeTxHash?: string;
  nonce?: number | string;
}

/**
 * Plan-time Ledger-hash preview (mirrors `printPlanDiff`'s
 * `mainTxPreview` + `nestedPreview` opts). The parent (main) Safe tx's
 * three hashes plus one row per nested signer. `messageHash`/`safeTxHash`/
 * per-child `messageHash`+`safeTxHash`+`nonce` are present only when the live
 * Safe tx was built (and the child nonce read succeeded); `domainHash` is
 * offline-computable so it is always present.
 */
interface NestedPreview {
  mainTx?: {
    domainHash: string;
    messageHash?: string;
    safeTxHash?: string;
    nonce?: number | string;
  };
  rows: NestedPreviewRow[];
}

/**
 * Build the LIVE Ledger-hash preview for a non-null plan that declares
 * `nestedSigners`. Resolves an RPC and builds the parent Safe tx to recover
 * its `safeTxHash` + struct message hash + nonce, then derives each child
 * Safe's domain/message/final hashes. This is best-effort: any failure (RPC
 * down, Safe not deployed) degrades to OFFLINE-computable domain hashes only
 * (parent + each child) and writes a one-line WARN — preview failure must
 * NEVER throw out of the plan/apply step, so the plan itself still succeeds.
 */
async function buildNestedPreview(
  plan: Plan,
  addressLabelMap: Record<string, string>,
  rpcUrlOverride: string | undefined,
  readNonce: ReadSafeNonceFn = readSafeNonce,
): Promise<NestedPreview> {
  if (plan.nestedSigners === undefined || plan.nestedSigners.length === 0) return { rows: [] };
  const { buildSafeTransaction, computeSafeTxMessageHash } = await import('./apply/safeApi');
  const { resolveRpcUrl } = await import('./apply/rpc');
  const { computeNestedApproveHashDetails, computeSafeDomainSeparator } =
    await import('./apply/nestedSafeHash');
  const labelFor = (child: string): string | undefined => addressLabelMap[child.toLowerCase()];
  // Degraded row: OFFLINE-computable child domain hash only (no RPC needed).
  const degradedRow = (child: string): NestedPreviewRow => {
    const label = labelFor(child);
    return {
      child,
      ...(label !== undefined ? { label } : {}),
      domainHash: computeSafeDomainSeparator(plan.chainId, child),
    };
  };
  const nestedSigners = plan.nestedSigners;
  try {
    const rpcUrl = resolveRpcUrl({
      chainId: plan.chainId,
      ...(rpcUrlOverride !== undefined ? { overrideUrl: rpcUrlOverride } : {}),
    });
    const { safeTxHash, safeTxData } = await buildSafeTransaction({
      chainId: plan.chainId,
      safeAddress: plan.safeAddress,
      calls: plan.calls,
      rpcUrl,
    });
    // Per-child: read the CHILD Safe's live nonce, then derive its approveHash
    // tx hashes. A child whose nonce read fails still gets a domain-only row.
    const rows: NestedPreviewRow[] = [];
    for (const child of nestedSigners) {
      const label = labelFor(child);
      try {
        const childNonce = await readNonce(rpcUrl, child);
        const d = computeNestedApproveHashDetails({
          parentSafe: plan.safeAddress,
          parentSafeTxHash: safeTxHash,
          childSafe: child,
          childNonce,
          chainId: plan.chainId,
        });
        rows.push({
          child,
          ...(label !== undefined ? { label } : {}),
          domainHash: d.domainHash,
          messageHash: d.messageHash,
          safeTxHash: d.safeTxHash,
          nonce: childNonce.toString(),
        });
      } catch (err) {
        process.stderr.write(
          `WARN: nested-signer preview hash for ${child} unavailable (child Safe nonce could not be read): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        rows.push(degradedRow(child));
      }
    }
    return {
      mainTx: {
        domainHash: computeSafeDomainSeparator(plan.chainId, plan.safeAddress),
        messageHash: computeSafeTxMessageHash(safeTxData),
        safeTxHash,
        nonce: safeTxData.nonce,
      },
      rows,
    };
  } catch (err) {
    process.stderr.write(
      `WARN: nested-signer preview hash unavailable (live Safe tx could not be built): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    // Degraded: domain hashes only (offline-computable), no message/final.
    return {
      mainTx: { domainHash: computeSafeDomainSeparator(plan.chainId, plan.safeAddress) },
      rows: nestedSigners.map(degradedRow),
    };
  }
}

/**
 * Emit the Ledger-hash lines after a submit/apply succeeds: ONE `main-tx`
 * line carrying the parent Safe tx's three hashes, then one `nested-signer`
 * line per child carrying its three PLUS the child's live nonce. The nested
 * flow is the standard Safe approval: a child Safe that is an owner of the
 * parent approves by executing `parentSafe.approveHash(parentSafeTxHash)`; the
 * child's own owners sign that child tx (nonce-derived — read live here). A
 * child whose nonce read fails is skipped with a WARN (never throws). No alias
 * labels here (they aren't threaded to submit) — addresses + hashes only.
 */
export async function emitNestedSignerLines(
  args: {
    safe: string;
    chainId: number;
    safeTxHash: string;
    safeTxData: SafeTxData;
    nestedSigners: string[];
    rpcUrl: string;
  },
  readNonce: ReadSafeNonceFn = readSafeNonce,
): Promise<void> {
  if (args.nestedSigners.length === 0) return;
  const { computeSafeTxMessageHash } = await import('./apply/safeApi');
  const { computeNestedApproveHashDetails, computeSafeDomainSeparator } =
    await import('./apply/nestedSafeHash');
  const mainDomainHash = computeSafeDomainSeparator(args.chainId, args.safe);
  const mainMessageHash = computeSafeTxMessageHash(args.safeTxData);
  process.stdout.write(
    `main-tx safe=${args.safe} chain=${args.chainId} ` +
      `domainHash=${mainDomainHash} messageHash=${mainMessageHash} safeTxHash=${args.safeTxHash}\n`,
  );
  for (const child of args.nestedSigners) {
    let childNonce: bigint;
    try {
      childNonce = await readNonce(args.rpcUrl, child);
    } catch (err) {
      process.stderr.write(
        `WARN: nested-signer hash for ${child} unavailable: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      continue;
    }
    const d = computeNestedApproveHashDetails({
      parentSafe: args.safe,
      parentSafeTxHash: args.safeTxHash,
      childSafe: child,
      childNonce,
      chainId: args.chainId,
    });
    process.stdout.write(
      `nested-signer safe=${args.safe} chain=${args.chainId} child=${child} nonce=${childNonce} ` +
        `domainHash=${d.domainHash} messageHash=${d.messageHash} safeTxHash=${d.safeTxHash}\n`,
    );
  }
}

interface BatchOutcome {
  ok: boolean;
}

/**
 * Run `fn` over every file in `files`. On failure, log to stderr and continue.
 * Returns `{ ok }` — false if any file failed.
 */
async function runBatch(
  files: string[],
  label: string,
  fn: (file: string) => Promise<void>,
): Promise<BatchOutcome> {
  if (files.length === 0) {
    process.stderr.write(`zac ${label}: no matching files found\n`);
    return { ok: false };
  }
  let failed = 0;
  for (const file of files) {
    try {
      await fn(file);
    } catch (err) {
      failed += 1;
      const msg =
        err instanceof ZacError
          ? formatError(err)
          : `unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
      process.stderr.write(`zac ${label} ${displayPath(file)}: ${msg}\n`);
    }
  }
  return { ok: failed === 0 };
}

/**
 * Run `fn` over every `PlanGroup`. On failure, log to stderr with
 * `safe=<address> chain=<id>` and continue. Caller is responsible for the
 * empty-groups case.
 */
async function runGroupBatch(
  groups: PlanGroup[],
  label: string,
  fn: (group: PlanGroup) => Promise<void>,
): Promise<BatchOutcome> {
  let failed = 0;
  for (const group of groups) {
    try {
      await fn(group);
    } catch (err) {
      failed += 1;
      const msg =
        err instanceof ZacError
          ? formatError(err)
          : `unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
      process.stderr.write(
        `zac ${label} safe=${group.safeAddress} chain=${group.chainId}: ${msg}\n`,
      );
    }
  }
  return { ok: failed === 0 };
}

/**
 * Run `fn` over every `SafeDir`. On failure, log to stderr with
 * `safe=<address> chain=<id>` and continue.
 */
async function runSafeDirBatch(
  safeDirs: SafeDir[],
  label: string,
  fn: (sd: SafeDir) => Promise<void>,
): Promise<BatchOutcome> {
  if (safeDirs.length === 0) {
    process.stderr.write(`zac ${label}: no matching files found\n`);
    return { ok: false };
  }
  let failed = 0;
  for (const sd of safeDirs) {
    try {
      await fn(sd);
    } catch (err) {
      failed += 1;
      const msg =
        err instanceof ZacError
          ? formatError(err)
          : `unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
      process.stderr.write(`zac ${label} safe=${sd.safeAddress} chain=${sd.chainId}: ${msg}\n`);
    }
  }
  return { ok: failed === 0 };
}

/**
 * `commander` flag parser for `--revoke-unmentioned <bool>`. Accepts the
 * usual boolean spellings; rejects anything else with a clear message
 * (raised as a `commander.InvalidArgumentError` so the help text fires).
 */
function parseBool(name: string, value: string): boolean {
  const v = value.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new ZacError({
    phase: 'load',
    message: `${name} must be one of true|false|1|0|yes|no|on|off; got '${value}'`,
  });
}

/**
 * Emit a one-line warning when the user explicitly passed
 * `--revoke-unmentioned=true` in file-mode, where the flag is a no-op.
 * Without this, the flag silently downgrades to legacy and the user has
 * no signal that their intent was ignored. Skipped when the flag is at
 * its default (`true`) or when the user explicitly chose `false` — file-
 * mode is always per-file legacy regardless of the flag value, so an
 * explicit `false` is consistent with the actual behavior.
 */
function warnIfFileFlagNoOp(
  command: Command,
  optionName: 'revokeUnmentioned',
  value: boolean,
  inputIsFile: boolean,
): void {
  if (!inputIsFile || value !== true) return;
  if (command.getOptionValueSource(optionName) !== 'cli') return;
  process.stderr.write(
    'WARN: --revoke-unmentioned has no effect in file-mode; pass a directory to enable per-safe-dir aggregation\n',
  );
}

/** A safe-dir is `<network>/<safe-address>/`; its own dir name is the 0x address. */
const SAFE_DIR_ADDR_RE = /^0x[0-9a-f]{40}$/;

/**
 * Within each safe-dir, reject plan-file sets that would bundle unintended
 * calls into the proposed Safe transaction. A safe-dir must contain EITHER a
 * single aggregated `<network>.<safe-address>.plan.json` (per-modifier mode)
 * OR one-or-more `<stem>.plan.json` files matching a sibling
 * `<stem>.zac.yaml` (legacy per-file mode).
 *
 * Four conditions are rejected:
 *  - A legacy-named `<safe-address>.plan.json` aggregated plan. `plan` writes
 *    the network-qualified basename, so this name can only come from a tree
 *    planned by an older build; the file is stale by construction and its
 *    calls describe a config revision that is no longer current.
 *  - MIXED styles, from running `plan` once with each `--revoke-unmentioned`
 *    value; bundling both would duplicate every grant/revoke.
 *  - MULTIPLE aggregated plans in one dir.
 *  - ORPHAN `<stem>.plan.json` with no sibling `<stem>.zac.yaml`: the source
 *    that produced it is gone, so its calls are unreviewable against the
 *    current source set.
 *
 * Only safe-dirs are inspected. A flat directory of collected plan files (e.g.
 * downloaded release assets) carries no `<network>/<safe-address>/` structure
 * to classify against and is left alone.
 */
function assertNoMixedSafeDirPlans(planPaths: string[]): void {
  // Group plan paths by their parent dir.
  const byDir = new Map<string, string[]>();
  for (const p of planPaths) {
    const dir = dirname(p);
    const list = byDir.get(dir);
    if (list === undefined) byDir.set(dir, [p]);
    else list.push(p);
  }
  for (const [dir, paths] of byDir) {
    const dirAddrLower = basename(dir).toLowerCase();
    if (!SAFE_DIR_ADDR_RE.test(dirAddrLower)) continue;
    const networkLower = basename(dirname(dir)).toLowerCase();
    const aggregatedNames: string[] = [];
    const staleAggregatedNames: string[] = [];
    const perFileStems: string[] = [];
    const orphanNames: string[] = [];
    for (const p of paths) {
      const stem = basename(p).slice(0, -'.plan.json'.length);
      const stemLower = stem.toLowerCase();
      // Match the aggregated basenames exactly. A suffix test would also
      // swallow a per-file plan whose stem merely ends in `.<safe-address>`,
      // dropping it from the mixed-style check below.
      const hasSource = existsSync(resolve(dir, `${stem}.zac.yaml`));
      if (stemLower === `${networkLower}.${dirAddrLower}`) {
        aggregatedNames.push(basename(p));
      } else if (stemLower === dirAddrLower && !hasSource) {
        staleAggregatedNames.push(basename(p));
      } else if (hasSource) {
        perFileStems.push(stem);
      } else {
        orphanNames.push(basename(p));
      }
    }
    if (staleAggregatedNames.length > 0) {
      throw new ZacError({
        phase: 'apply',
        message: `safe-dir ${dir} contains stale aggregated plan(s) (${staleAggregatedNames.join(', ')}) using the un-qualified '${dirAddrLower}.plan.json' basename; the current aggregated basename is '${networkLower}.${dirAddrLower}.plan.json', so these were written by an older build and would bundle a superseded revision into the proposal — delete them and re-run plan`,
      });
    }
    if (aggregatedNames.length > 1) {
      throw new ZacError({
        phase: 'apply',
        message: `safe-dir ${dir} contains MULTIPLE aggregated plans (${aggregatedNames.join(', ')}); exactly one is expected — delete all but the current one or re-run plan`,
      });
    }
    if (aggregatedNames.length > 0 && perFileStems.length > 0) {
      throw new ZacError({
        phase: 'apply',
        message: `safe-dir ${dir} contains BOTH legacy per-file plan(s) (${perFileStems.map((s) => `${s}.plan.json`).join(', ')}) AND an aggregated plan (${aggregatedNames.join(', ')}); these are mutually exclusive — delete one set or re-run plan with the desired mode`,
      });
    }
    if (orphanNames.length > 0) {
      throw new ZacError({
        phase: 'apply',
        message: `safe-dir ${dir} contains orphan plan file(s) (${orphanNames.join(', ')}) with no sibling '<stem>.zac.yaml'; the source that produced them is gone, so their calls cannot be reviewed against the current sources — delete them or restore the source`,
      });
    }
  }
}

/**
 * Resolve the per-file legacy plan/apply input set. Accepts either:
 * - a `*.zac.yaml` file (single-source: we translate to its sibling
 *   generated `*.yaml`, applying the same layout validation as
 *   `findGeneratedConfigs`), or
 * - a directory (walked recursively via `findGeneratedConfigs`).
 *
 * Generated `*.yaml` files are NOT accepted as direct input — the CLI
 * surface is uniform across subcommands and users always pass the source
 * `*.zac.yaml`. Passing a `*.yaml` produces a clear error suggesting the
 * `.zac.yaml` sibling.
 *
 * For each resolved source, the generated sibling is `existsSync`-checked
 * so the friendly "run `zac generate` first" error mirrors the safe-dir
 * path's wording (see `findSafeDirs` in discover.ts).
 */
function resolveGeneratedInputs(
  inputPath: string,
  inputIsFile: boolean,
  absInput: string,
): string[] {
  if (inputIsFile) {
    if (absInput.endsWith('.zac.yaml')) {
      // Single-file mode with a source file. Validate layout via
      // `findZacSources` (which throws on bad layout), then translate to
      // the sibling generated `.yaml`.
      const sources = findZacSources(absInput);
      const generated = sources.map(generatedPathFor);
      for (let i = 0; i < generated.length; i += 1) {
        if (!existsSync(generated[i]!)) {
          throw new ZacError({
            phase: 'load',
            message: `missing generated config for ${sources[i]!}; run \`zac generate\` first`,
            sourceLocation: { file: sources[i]! },
          });
        }
      }
      return generated;
    }
    if (absInput.endsWith('.yaml')) {
      // Reject generated `.yaml` direct input — uniform CLI surface.
      const suggested = absInput.slice(0, -'.yaml'.length) + '.zac.yaml';
      throw new ZacError({
        phase: 'load',
        message: `expected a source file ending in .zac.yaml (not a generated .yaml): ${absInput} — pass ${suggested} instead`,
      });
    }
    // Anything else (e.g. .json, .txt) — fall through to findGeneratedConfigs
    // which surfaces a clean phase=load error.
    return findGeneratedConfigs(inputPath);
  }
  // Directory mode: existence-checking of each generated sibling is handled
  // inside `findGeneratedConfigs` (the file-mode case there is unused now).
  return findGeneratedConfigs(inputPath);
}

export function buildProgram(): Command {
  const program = new Command();
  program.name('zac').description('Zodiac Roles V2 config generator').exitOverride();

  program
    .command('generate <path>')
    .description(
      'generate Zodiac Roles V2 configs from `*.zac.yaml` sources; <path> is a file or directory (walked recursively). Output is written alongside each source as `<stem>.yaml`. Sources must live at `<network>/<safe-address>/<name>.zac.yaml`.',
    )
    .option('--config <path>', 'override path to root config.yaml (default: walk up)')
    .option(
      '--out <path>',
      'write the generated config to this exact path instead of alongside the source (single-source input only)',
    )
    .action(async (inputPath: string, options: { config?: string; out?: string }) => {
      const sources = findZacSources(inputPath);
      if (options.out !== undefined && sources.length !== 1) {
        throw new ZacError({
          phase: 'emit',
          message: `--out requires a single source, got ${sources.length}`,
        });
      }
      const { ok } = await runBatch(sources, 'generate', async (source) => {
        const outPath = options.out ?? generatedPathFor(source);
        const opts: Parameters<typeof runGenerate>[0] = { configPath: source, outPath };
        if (options.config !== undefined) opts.configOverride = options.config;
        await runGenerate(opts);
        process.stdout.write(`generated: ${displayPath(outPath)}\n`);
      });
      if (!ok) {
        throw new ZacError({ phase: 'emit', message: 'one or more generate steps failed' });
      }
    });

  program
    .command('plan <path>')
    .description(
      "compute role-state-update calls + Safe TX hash; output as JSON (no signing, no posting). <path> is a `*.zac.yaml` file or a directory (walked recursively — sources must live at `<network>/<safe-address>/<name>.zac.yaml`). By default (`--revoke-unmentioned=true`) in directory mode, plans are aggregated per safe-dir and the SDK's `planApply` emits revoke calls for any role on the modifier not in the aggregated set; output is `<network>.<safe-address>.plan.json` inside each safe-dir. Safe-dir mode is also the only mode that consults `safe.yaml` for Safe-level config (guard/fallback/modules). Pass `--revoke-unmentioned=false` to opt into the legacy per-file flow: each source produces a `<stem>.plan.json` via `planApplyRole` with no revokes, and `safe.yaml` is ignored. RPC URL is resolved per-chainId via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`), falling back to `RPC_URL`.",
    )
    .option(
      '--rpc-url <url>',
      'RPC URL for chain reads (Safe nonce, role state); overrides any per-chain or `RPC_URL` env var',
    )
    .option(
      '--revoke-unmentioned <bool>',
      "when true (DEFAULT), directory-mode aggregates roles per safe-dir and uses the SDK's `planApply` (which natively revokes any role on the modifier not in the aggregated set) — also the only mode that consults `safe.yaml` for Safe-level config (guard/fallback/modules). when false, every source is planned independently via `planApplyRole`, no revokes are emitted, and `safe.yaml` is ignored. ignored in file-mode (always per-file legacy).",
      (v: string) => parseBool('--revoke-unmentioned', v),
      true,
    )
    .option(
      '--out <path>',
      'write the plan JSON to this exact path instead of the derived `*.plan.json` (file-mode / single-source input only)',
    )
    .option('--config <path>', 'override path to root config.yaml (default: walk up)')
    .action(
      async (
        inputPath: string,
        options: { rpcUrl?: string; revokeUnmentioned: boolean; out?: string; config?: string },
        command: Command,
      ) => {
        const { runPlan } = await import('./apply/runPlan');
        const { runPlanForSafeDir } = await import('./apply/runPlanForSafeDir');
        const { serializePlan } = await import('./apply/planSchema');
        const { printPlanDiff } = await import('./apply/printPlanDiff');
        const { buildSelectorMap } = await import('./apply/buildSelectorMap');
        const { buildFunctionParamMap } = await import('./apply/buildFunctionParamMap');
        const { buildAddressLabelMap } = await import('./apply/buildAddressLabelMap');
        const { loadAllAliases } = await import('./load/loadAllAliases');
        const { findConfig: findConfigRaw } = await import('./load/findConfig');
        const findConfig: typeof findConfigRaw = (args) =>
          options.config !== undefined
            ? findConfigRaw({ ...args, override: options.config })
            : findConfigRaw(args);
        const sdk = await loadDiffSdk();

        const absInput = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
        // Surface missing-path errors as `phase=load` (mirrors `submit`).
        if (!existsSync(absInput)) {
          throw new ZacError({ phase: 'load', message: `path not found: ${absInput}` });
        }
        const inputIsFile = statSync(absInput).isFile();
        warnIfFileFlagNoOp(command, 'revokeUnmentioned', options.revokeUnmentioned, inputIsFile);
        const useSafeDirMode = options.revokeUnmentioned && !inputIsFile;

        if (useSafeDirMode) {
          const safeDirs = findSafeDirs(inputPath);
          const { ok } = await runSafeDirBatch(safeDirs, 'plan', async (sd) => {
            const planOpts: Parameters<typeof runPlanForSafeDir>[0] = { safeDir: sd };
            if (options.rpcUrl !== undefined) planOpts.rpcUrl = options.rpcUrl;
            const plan = await runPlanForSafeDir(planOpts);
            if (plan === null) {
              // In sync: skip write, skip diff — surface as a quiet success
              // line. Any pre-existing plan.json is left on disk; `submit`
              // rejects the stale ones rather than bundling them (see
              // `assertNoMixedSafeDirPlans`).
              process.stdout.write(`in sync: ${displayPath(sd.dirPath)} — nothing to plan\n`);
              return;
            }
            const json = serializePlan(plan);
            const outPath = safeDirPlanPathFor(sd);
            writeFileSync(outPath, json);
            const addressLabelMap = await buildAddressLabelMapForSources(
              sd.sources,
              buildAddressLabelMap,
              loadAllAliases,
              findConfig,
            );
            // LIVE Ledger-hash preview (best-effort; never throws out).
            const preview = plan.nestedSigners?.length
              ? await buildNestedPreview(plan, addressLabelMap, options.rpcUrl)
              : { rows: [] };
            printPlanDiff(plan, {
              planPath: displayPath(outPath),
              safeAddress: plan.safeAddress,
              declaredRoleKeys: declaredRoleKeysForSafeDir(sd),
              selectorMap: buildSelectorMapForSources(sd.sources, buildSelectorMap),
              addressLabelMap,
              functionParamMap: buildFunctionParamMapForSources(sd.sources, buildFunctionParamMap),
              ...(preview.mainTx !== undefined ? { mainTxPreview: preview.mainTx } : {}),
              ...(preview.rows.length > 0 ? { nestedPreview: preview.rows } : {}),
              sdk,
            });
            process.stdout.write(`planned: ${displayPath(outPath)}\n`);
          });
          if (!ok) {
            throw new ZacError({ phase: 'apply', message: 'one or more plan steps failed' });
          }
          return;
        }

        // Legacy per-file flow: file mode always; directory mode when
        // `--revoke-unmentioned=false`. Accept either a `*.zac.yaml` (we
        // translate to its sibling generated `*.yaml`) or a directory.
        const generated = resolveGeneratedInputs(inputPath, inputIsFile, absInput);
        if (options.out !== undefined && generated.length !== 1) {
          throw new ZacError({
            phase: 'apply',
            message: `--out requires a single generated input, got ${generated.length}`,
          });
        }
        const { ok } = await runBatch(generated, 'plan', async (genPath) => {
          const planOpts: Parameters<typeof runPlan>[0] = { generatedPath: genPath };
          const plan = await runPlan(planOpts);
          if (plan === null) {
            // In sync: skip write, skip diff. Do NOT touch any existing
            // stale plan.json — surface as a quiet success line.
            process.stdout.write(`in sync: ${displayPath(genPath)} — nothing to plan\n`);
            return;
          }
          const json = serializePlan(plan);
          const outPath = options.out ?? planPathFor(genPath);
          writeFileSync(outPath, json);
          printPlanDiff(plan, {
            planPath: displayPath(outPath),
            safeAddress: plan.safeAddress,
            selectorMap: buildSelectorMapForSources([sourcePathFor(genPath)], buildSelectorMap),
            addressLabelMap: await buildAddressLabelMapForSources(
              [sourcePathFor(genPath)],
              buildAddressLabelMap,
              loadAllAliases,
              findConfig,
            ),
            functionParamMap: buildFunctionParamMapForSources(
              [sourcePathFor(genPath)],
              buildFunctionParamMap,
            ),
            sdk,
          });
          process.stdout.write(`planned: ${displayPath(outPath)}\n`);
        });
        if (!ok) {
          throw new ZacError({ phase: 'apply', message: 'one or more plan steps failed' });
        }
      },
    );

  program
    .command('submit <path>')
    .description(
      'sign + post plan JSON files to Safe Transaction Service (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY). <path> is a `.plan.json` file (posted as-is) or a directory (walked recursively — plans are auto-bundled per Safe so each Safe gets ONE proposal regardless of how many plan files target it). RPC URL is resolved per-chainId via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`), falling back to `RPC_URL`.',
    )
    .action(async (inputPath: string) => {
      const { runSubmit, runBundledSubmit } = await import('./apply/runSubmit');
      const { parsePlan } = await import('./apply/planSchema');
      const { computeSafeTxMessageHash } = await import('./apply/safeApi');
      const { resolveRpcUrl } = await import('./apply/rpc');
      const proposerKey = process.env['ZAC_PROPOSER_PRIVATE_KEY'] as `0x${string}` | undefined;
      if (proposerKey === undefined) {
        throw new ZacError({
          phase: 'apply',
          message: 'ZAC_PROPOSER_PRIVATE_KEY env var is required for submit',
        });
      }

      // File-mode: post the single plan as-is (preserves the
      // inspect-the-hash-then-submit flow). Directory-mode: auto-bundle by
      // `(safeAddress, chainId)`. We probe the input via `findPlans` first
      // (which produces the right ZacError for missing paths), then dispatch
      // based on whether the resolved path is a regular file.
      const planPaths = findPlans(inputPath);
      const absInput = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
      const inputIsFile = statSync(absInput).isFile();

      if (inputIsFile) {
        const planPath = planPaths[0];
        if (planPath === undefined) {
          throw new ZacError({ phase: 'apply', message: 'no plan file resolved' });
        }
        const plan = parsePlan(readFileSync(planPath, 'utf8'));
        const submitArgs: Parameters<typeof runSubmit>[0] = {
          plan,
          proposerPrivateKey: proposerKey,
        };
        const apiKey = process.env['SAFE_API_KEY'];
        if (apiKey !== undefined) submitArgs.apiKey = apiKey;
        // RPC URL is resolved per-chainId inside runSubmit (see resolveRpcUrl).
        const result = await runSubmit(submitArgs);
        const messageHash = computeSafeTxMessageHash(result.safeTxData);
        process.stdout.write(
          `submitted ${displayPath(planPath)}: ` +
            `safe=${plan.safeAddress} chain=${plan.chainId} ` +
            `plans=1 calls=${result.callsCount} ` +
            `nonce=${result.safeTxData.nonce} operation=${result.safeTxData.operation} ` +
            `safeTxHash=${result.safeTxHash} messageHash=${messageHash}\n`,
        );
        if (plan.nestedSigners?.length) {
          await emitNestedSignerLines({
            safe: plan.safeAddress,
            chainId: plan.chainId,
            safeTxHash: result.safeTxHash,
            safeTxData: result.safeTxData,
            nestedSigners: plan.nestedSigners,
            rpcUrl: resolveRpcUrl({ chainId: plan.chainId }),
          });
        }
        return;
      }

      // Directory-mode.
      if (planPaths.length === 0) {
        process.stderr.write('zac submit: no matching files found\n');
        throw new ZacError({ phase: 'apply', message: 'one or more submit steps failed' });
      }
      // Reject the mixed-style condition (aggregated + per-file plans in
      // the same safe-dir) before grouping. Without this, bundled-submit
      // would flatten BOTH styles' calls into one transaction, duplicating
      // every grant/revoke.
      assertNoMixedSafeDirPlans(planPaths);
      const plans = planPaths.map((p) => parsePlan(readFileSync(p, 'utf8')));
      const groups = groupPlansBySafe(plans);
      const { ok } = await runGroupBatch(groups, 'submit', async (group) => {
        const submitArgs: Parameters<typeof runBundledSubmit>[0] = {
          plans: group.plans,
          proposerPrivateKey: proposerKey,
        };
        const apiKey = process.env['SAFE_API_KEY'];
        if (apiKey !== undefined) submitArgs.apiKey = apiKey;
        // RPC URL is resolved per-chainId inside runBundledSubmit (see resolveRpcUrl).
        const result = await runBundledSubmit(submitArgs);
        const messageHash = computeSafeTxMessageHash(result.safeTxData);
        // Key=value log line — parsed by downstream tooling
        // (build-release-body.ts) to recover the BUNDLED tx data that
        // signers must verify on hardware. The fields after `submitted` are
        // intentionally space-separated `key=value` pairs (stable across
        // versions); pre-bundle per-plan hashes from `*.plan.json` are NOT
        // valid post-bundle and must be replaced by these values.
        process.stdout.write(
          `submitted safe=${group.safeAddress} chain=${group.chainId} ` +
            `plans=${group.plans.length} calls=${result.callsCount} ` +
            `nonce=${result.safeTxData.nonce} operation=${result.safeTxData.operation} ` +
            `safeTxHash=${result.safeTxHash} messageHash=${messageHash}\n`,
        );
        // Union of nested signers across the bundled plans (lowercase +
        // dedupe). Emitted once per child under the group's safeTxHash.
        const groupNested = [
          ...new Set(
            group.plans.flatMap((p) => (p.nestedSigners ?? []).map((s) => s.toLowerCase())),
          ),
        ];
        if (groupNested.length > 0) {
          await emitNestedSignerLines({
            safe: group.safeAddress,
            chainId: group.chainId,
            safeTxHash: result.safeTxHash,
            safeTxData: result.safeTxData,
            nestedSigners: groupNested,
            rpcUrl: resolveRpcUrl({ chainId: group.chainId }),
          });
        }
      });
      if (!ok) {
        throw new ZacError({ phase: 'apply', message: 'one or more submit steps failed' });
      }
    });

  program
    .command('apply <path>')
    .description(
      'propose role state updates as Safe transactions (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY). <path> is a `*.zac.yaml` file or a directory (walked recursively — sources must live at `<network>/<safe-address>/<name>.zac.yaml`). By default (`--revoke-unmentioned=true`) in directory mode, one Safe transaction per safe-dir aggregates all sources via `planApply` (revoking any unmentioned role) and Safe-level config from `safe.yaml` (guard/fallback/modules) is included. Pass `--revoke-unmentioned=false` to opt into the legacy per-file flow: each source proposes its own per-role transaction via `planApplyRole`, no revokes, and `safe.yaml` is ignored. RPC URL is resolved per-chainId via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`), falling back to `RPC_URL`.',
    )
    .option(
      '--rpc-url <url>',
      'RPC URL for chain reads (Safe nonce, role state); overrides any per-chain or `RPC_URL` env var',
    )
    .option(
      '--revoke-unmentioned <bool>',
      "when true (DEFAULT), directory-mode aggregates roles per safe-dir and uses the SDK's `planApply` (which natively revokes any role on the modifier not in the aggregated set) — also the only mode that consults `safe.yaml` for Safe-level config (guard/fallback/modules). when false, every source is applied independently via `planApplyRole`, no revokes are emitted, and `safe.yaml` is ignored. ignored in file-mode (always per-file legacy).",
      (v: string) => parseBool('--revoke-unmentioned', v),
      true,
    )
    .action(
      async (
        inputPath: string,
        options: { rpcUrl?: string; revokeUnmentioned: boolean },
        command: Command,
      ) => {
        // `apply` is `plan + submit` chained internally. We dispatch the
        // two stages explicitly (rather than calling `runApply`) so we can
        // print the plan diff between them — users see what's about to be
        // proposed before the Safe Transaction Service post.
        const { runPlan } = await import('./apply/runPlan');
        const { runPlanForSafeDir } = await import('./apply/runPlanForSafeDir');
        const { runSubmit } = await import('./apply/runSubmit');
        const { resolveRpcUrl } = await import('./apply/rpc');
        const { printPlanDiff } = await import('./apply/printPlanDiff');
        const { buildSelectorMap } = await import('./apply/buildSelectorMap');
        const { buildFunctionParamMap } = await import('./apply/buildFunctionParamMap');
        const { buildAddressLabelMap } = await import('./apply/buildAddressLabelMap');
        const { loadAllAliases } = await import('./load/loadAllAliases');
        const { findConfig } = await import('./load/findConfig');
        const sdk = await loadDiffSdk();

        // Pre-validate the proposer key once, before any batch starts.
        // Without this, N safe-dirs / N sources would each surface their own
        // copy of the same error.
        const proposerKey = process.env['ZAC_PROPOSER_PRIVATE_KEY'] as `0x${string}` | undefined;
        if (proposerKey === undefined) {
          throw new ZacError({
            phase: 'apply',
            message: 'ZAC_PROPOSER_PRIVATE_KEY env var is required for apply',
          });
        }
        const apiKey = process.env['SAFE_API_KEY'];

        const absInput = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
        if (!existsSync(absInput)) {
          throw new ZacError({ phase: 'load', message: `path not found: ${absInput}` });
        }
        const inputIsFile = statSync(absInput).isFile();
        warnIfFileFlagNoOp(command, 'revokeUnmentioned', options.revokeUnmentioned, inputIsFile);
        const useSafeDirMode = options.revokeUnmentioned && !inputIsFile;

        if (useSafeDirMode) {
          const safeDirs = findSafeDirs(inputPath);
          const { ok } = await runSafeDirBatch(safeDirs, 'apply', async (sd) => {
            const planOpts: Parameters<typeof runPlanForSafeDir>[0] = { safeDir: sd };
            if (options.rpcUrl !== undefined) planOpts.rpcUrl = options.rpcUrl;
            const plan = await runPlanForSafeDir(planOpts);
            if (plan === null) {
              // In sync: nothing to submit. No Safe tx proposed.
              process.stdout.write(`in sync: ${displayPath(sd.dirPath)} — nothing to plan\n`);
              return;
            }
            // Print the diff using the safe-dir's plan-file path as the
            // header (it's the canonical artifact name even when we don't
            // write it — `apply` doesn't persist the plan).
            const addressLabelMap = await buildAddressLabelMapForSources(
              sd.sources,
              buildAddressLabelMap,
              loadAllAliases,
              findConfig,
            );
            // LIVE Ledger-hash preview (best-effort; never throws out).
            const preview = plan.nestedSigners?.length
              ? await buildNestedPreview(plan, addressLabelMap, options.rpcUrl)
              : { rows: [] };
            printPlanDiff(plan, {
              planPath: displayPath(safeDirPlanPathFor(sd)),
              safeAddress: plan.safeAddress,
              declaredRoleKeys: declaredRoleKeysForSafeDir(sd),
              selectorMap: buildSelectorMapForSources(sd.sources, buildSelectorMap),
              addressLabelMap,
              functionParamMap: buildFunctionParamMapForSources(sd.sources, buildFunctionParamMap),
              ...(preview.mainTx !== undefined ? { mainTxPreview: preview.mainTx } : {}),
              ...(preview.rows.length > 0 ? { nestedPreview: preview.rows } : {}),
              sdk,
            });
            const submitArgs: Parameters<typeof runSubmit>[0] = {
              plan,
              proposerPrivateKey: proposerKey,
            };
            if (apiKey !== undefined) submitArgs.apiKey = apiKey;
            if (options.rpcUrl !== undefined) submitArgs.rpcUrl = options.rpcUrl;
            const result = await runSubmit(submitArgs);
            process.stdout.write(
              `applied safe=${sd.safeAddress} chain=${sd.chainId} (${sd.sources.length} source${sd.sources.length === 1 ? '' : 's'}): safeTxHash ${result.safeTxHash}\n`,
            );
            if (plan.nestedSigners?.length) {
              await emitNestedSignerLines({
                safe: plan.safeAddress,
                chainId: plan.chainId,
                safeTxHash: result.safeTxHash,
                safeTxData: result.safeTxData,
                nestedSigners: plan.nestedSigners,
                rpcUrl: resolveRpcUrl({
                  chainId: plan.chainId,
                  ...(options.rpcUrl ? { overrideUrl: options.rpcUrl } : {}),
                }),
              });
            }
          });
          if (!ok) {
            throw new ZacError({ phase: 'apply', message: 'one or more apply steps failed' });
          }
          return;
        }

        // Legacy per-file flow.
        const generated = resolveGeneratedInputs(inputPath, inputIsFile, absInput);
        const { ok } = await runBatch(generated, 'apply', async (genPath) => {
          const planOpts: Parameters<typeof runPlan>[0] = { generatedPath: genPath };
          const plan = await runPlan(planOpts);
          if (plan === null) {
            // In sync: nothing to submit. No Safe tx proposed.
            process.stdout.write(`in sync: ${displayPath(genPath)} — nothing to plan\n`);
            return;
          }
          printPlanDiff(plan, {
            planPath: displayPath(planPathFor(genPath)),
            safeAddress: plan.safeAddress,
            selectorMap: buildSelectorMapForSources([sourcePathFor(genPath)], buildSelectorMap),
            addressLabelMap: await buildAddressLabelMapForSources(
              [sourcePathFor(genPath)],
              buildAddressLabelMap,
              loadAllAliases,
              findConfig,
            ),
            functionParamMap: buildFunctionParamMapForSources(
              [sourcePathFor(genPath)],
              buildFunctionParamMap,
            ),
            sdk,
          });
          const submitArgs: Parameters<typeof runSubmit>[0] = {
            plan,
            proposerPrivateKey: proposerKey,
          };
          if (apiKey !== undefined) submitArgs.apiKey = apiKey;
          if (options.rpcUrl !== undefined) submitArgs.rpcUrl = options.rpcUrl;
          const result = await runSubmit(submitArgs);
          process.stdout.write(
            `applied ${displayPath(genPath)}: safeTxHash ${result.safeTxHash}\n`,
          );
          // Legacy `runPlan` never sets `nestedSigners` (file-mode ignores
          // safe.yaml); the guard keeps the emit uniform across branches.
          if (plan.nestedSigners?.length) {
            await emitNestedSignerLines({
              safe: plan.safeAddress,
              chainId: plan.chainId,
              safeTxHash: result.safeTxHash,
              safeTxData: result.safeTxData,
              nestedSigners: plan.nestedSigners,
              rpcUrl: resolveRpcUrl({
                chainId: plan.chainId,
                ...(options.rpcUrl ? { overrideUrl: options.rpcUrl } : {}),
              }),
            });
          }
        });
        if (!ok) {
          throw new ZacError({ phase: 'apply', message: 'one or more apply steps failed' });
        }
      },
    );

  return program;
}

async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof ZacError) {
      process.stderr.write(formatError(err) + '\n');
      return 1;
    }
    const anyErr = err as { exitCode?: number; code?: string; message?: string };
    if (anyErr && typeof anyErr.exitCode === 'number') {
      return anyErr.exitCode;
    }
    process.stderr.write(
      `unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return 2;
  }
}

if (typeof Bun !== 'undefined' && (import.meta as BunImportMeta).path === Bun.main) {
  const argv = process.argv.slice(2);
  main(argv).then((code) => process.exit(code));
}

export { main };
