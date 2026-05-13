#!/usr/bin/env bun
import { Command } from 'commander';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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
  type PlanGroup,
  type SafeDir,
} from './discover';
import { runGenerate } from './runGenerate';

declare const Bun: { main: string } | undefined;

interface BunImportMeta extends ImportMeta {
  path?: string;
}

function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  // If the relative path escapes cwd, fall back to absolute.
  return rel.startsWith('..') ? p : rel;
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
 * Resolve the per-file legacy plan/apply input set. Accepts either:
 * - a `*.zac.yaml` file (single-source: we translate to its sibling
 *   generated `*.yaml`, applying the same layout validation as
 *   `findGeneratedConfigs`),
 * - a generated `*.yaml` file (already validated), or
 * - a directory (walked recursively via `findGeneratedConfigs`).
 */
function resolveGeneratedInputs(
  inputPath: string,
  inputIsFile: boolean,
  absInput: string,
): string[] {
  if (inputIsFile && absInput.endsWith('.zac.yaml')) {
    // Single-file mode with a source file. Validate layout via
    // `findZacSources` (which throws on bad layout), then translate to
    // the sibling generated `.yaml`.
    const sources = findZacSources(absInput);
    return sources.map(generatedPathFor);
  }
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
    .action(async (inputPath: string, options: { config?: string }) => {
      const sources = findZacSources(inputPath);
      const { ok } = await runBatch(sources, 'generate', async (source) => {
        const outPath = generatedPathFor(source);
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
      "compute role-state-update calls + Safe TX hash; output as JSON (no signing, no posting). <path> is a `*.zac.yaml` file or a directory (walked recursively — sources must live at `<network>/<safe-address>/<name>.zac.yaml`). In directory mode (default `--revoke-unmentioned=true`), plans are aggregated per safe-dir and the SDK's `planApply` emits revoke calls for any role on the modifier not in the aggregated set; output is `<safe-address>.plan.json` inside each safe-dir. With `--revoke-unmentioned=false` (or in file mode), each source produces a per-file `<stem>.plan.json` via `planApplyRole` with no revokes. RPC URL is resolved per-chainId via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`), falling back to `RPC_URL`.",
    )
    .option(
      '--rpc-url <url>',
      'RPC URL for chain reads (Safe nonce, role state); overrides any per-chain or `RPC_URL` env var',
    )
    .option(
      '--revoke-unmentioned <bool>',
      "when true (default), directory-mode aggregates roles per safe-dir and uses the SDK's `planApply` (which natively revokes any role on the modifier not in the aggregated set). when false, every source is planned independently via `planApplyRole` and no revokes are emitted. ignored in file-mode (always per-file legacy).",
      (v: string) => parseBool('--revoke-unmentioned', v),
      true,
    )
    .action(async (inputPath: string, options: { rpcUrl?: string; revokeUnmentioned: boolean }) => {
      const { runPlan } = await import('./apply/runPlan');
      const { runPlanForSafeDir } = await import('./apply/runPlanForSafeDir');
      const { serializePlan } = await import('./apply/planSchema');

      const absInput = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
      // Surface missing-path errors as `phase=load` (mirrors `submit`).
      if (!existsSync(absInput)) {
        throw new ZacError({ phase: 'load', message: `path not found: ${absInput}` });
      }
      const inputIsFile = statSync(absInput).isFile();
      const useSafeDirMode = options.revokeUnmentioned && !inputIsFile;

      if (useSafeDirMode) {
        const safeDirs = findSafeDirs(inputPath);
        const { ok } = await runSafeDirBatch(safeDirs, 'plan', async (sd) => {
          const planOpts: Parameters<typeof runPlanForSafeDir>[0] = { safeDir: sd };
          if (options.rpcUrl !== undefined) planOpts.rpcUrl = options.rpcUrl;
          const plan = await runPlanForSafeDir(planOpts);
          const json = serializePlan(plan);
          const outPath = safeDirPlanPathFor(sd);
          writeFileSync(outPath, json);
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
      const { ok } = await runBatch(generated, 'plan', async (genPath) => {
        const planOpts: Parameters<typeof runPlan>[0] = { generatedPath: genPath };
        if (options.rpcUrl !== undefined) planOpts.rpcUrl = options.rpcUrl;
        const plan = await runPlan(planOpts);
        const json = serializePlan(plan);
        const outPath = planPathFor(genPath);
        writeFileSync(outPath, json);
        process.stdout.write(`planned: ${displayPath(outPath)}\n`);
      });
      if (!ok) {
        throw new ZacError({ phase: 'apply', message: 'one or more plan steps failed' });
      }
    });

  program
    .command('submit <path>')
    .description(
      'sign + post plan JSON files to Safe Transaction Service (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY). <path> is a `.plan.json` file (posted as-is) or a directory (walked recursively — plans are auto-bundled per Safe so each Safe gets ONE proposal regardless of how many plan files target it). RPC URL is resolved per-chainId via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`), falling back to `RPC_URL`.',
    )
    .action(async (inputPath: string) => {
      const { runSubmit, runBundledSubmit } = await import('./apply/runSubmit');
      const { parsePlan } = await import('./apply/planSchema');
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
        process.stdout.write(
          `submitted ${displayPath(planPath)}: safeTxHash ${result.safeTxHash}\n`,
        );
        return;
      }

      // Directory-mode.
      if (planPaths.length === 0) {
        process.stderr.write('zac submit: no matching files found\n');
        throw new ZacError({ phase: 'apply', message: 'one or more submit steps failed' });
      }
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
        process.stdout.write(
          `submitted safe=${group.safeAddress} chain=${group.chainId} (${group.plans.length} plan${group.plans.length === 1 ? '' : 's'}): safeTxHash ${result.safeTxHash}\n`,
        );
      });
      if (!ok) {
        throw new ZacError({ phase: 'apply', message: 'one or more submit steps failed' });
      }
    });

  program
    .command('apply <path>')
    .description(
      'propose role state updates as Safe transactions (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY). <path> is a `*.zac.yaml` file or a directory (walked recursively — sources must live at `<network>/<safe-address>/<name>.zac.yaml`). In directory mode (default `--revoke-unmentioned=true`), one Safe transaction per safe-dir aggregates all sources via `planApply` (revoking any unmentioned role). With `--revoke-unmentioned=false` (or in file mode), each source proposes its own per-role transaction via `planApplyRole`. RPC URL is resolved per-chainId via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`), falling back to `RPC_URL`.',
    )
    .option(
      '--rpc-url <url>',
      'RPC URL for chain reads (Safe nonce, role state); overrides any per-chain or `RPC_URL` env var',
    )
    .option(
      '--revoke-unmentioned <bool>',
      "when true (default), directory-mode aggregates roles per safe-dir and uses the SDK's `planApply` (which natively revokes any role on the modifier not in the aggregated set). when false, every source is applied independently via `planApplyRole` and no revokes are emitted. ignored in file-mode (always per-file legacy).",
      (v: string) => parseBool('--revoke-unmentioned', v),
      true,
    )
    .action(async (inputPath: string, options: { rpcUrl?: string; revokeUnmentioned: boolean }) => {
      const { runApply } = await import('./apply/runApply');
      const { runApplyForSafeDir } = await import('./apply/runApplyForSafeDir');

      const absInput = isAbsolute(inputPath) ? inputPath : resolve(inputPath);
      if (!existsSync(absInput)) {
        throw new ZacError({ phase: 'load', message: `path not found: ${absInput}` });
      }
      const inputIsFile = statSync(absInput).isFile();
      const useSafeDirMode = options.revokeUnmentioned && !inputIsFile;

      if (useSafeDirMode) {
        const safeDirs = findSafeDirs(inputPath);
        const { ok } = await runSafeDirBatch(safeDirs, 'apply', async (sd) => {
          const applyOpts: Parameters<typeof runApplyForSafeDir>[0] = { safeDir: sd };
          if (options.rpcUrl !== undefined) applyOpts.rpcUrl = options.rpcUrl;
          const result = await runApplyForSafeDir(applyOpts);
          process.stdout.write(
            `applied safe=${sd.safeAddress} chain=${sd.chainId} (${sd.sources.length} source${sd.sources.length === 1 ? '' : 's'}): safeTxHash ${result.safeTxHash}\n`,
          );
        });
        if (!ok) {
          throw new ZacError({ phase: 'apply', message: 'one or more apply steps failed' });
        }
        return;
      }

      // Legacy per-file flow.
      const generated = resolveGeneratedInputs(inputPath, inputIsFile, absInput);
      const { ok } = await runBatch(generated, 'apply', async (genPath) => {
        const applyOpts: Parameters<typeof runApply>[0] = { generatedPath: genPath };
        if (options.rpcUrl !== undefined) applyOpts.rpcUrl = options.rpcUrl;
        const result = await runApply(applyOpts);
        process.stdout.write(`applied ${displayPath(genPath)}: safeTxHash ${result.safeTxHash}\n`);
      });
      if (!ok) {
        throw new ZacError({ phase: 'apply', message: 'one or more apply steps failed' });
      }
    });

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
