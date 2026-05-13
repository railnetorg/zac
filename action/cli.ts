#!/usr/bin/env bun
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { ZacError, formatError } from './errors';
import {
  findGeneratedConfigs,
  findPlans,
  findZacSources,
  generatedPathFor,
  planPathFor,
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

export function buildProgram(): Command {
  const program = new Command();
  program.name('zac').description('Zodiac Roles V2 config generator').exitOverride();

  program
    .command('generate <path>')
    .description(
      'generate Zodiac Roles V2 configs from `*.zac.yaml` sources; <path> is a file or directory (walked recursively). Output is written alongside each source as `<stem>.yaml`.',
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
      'compute role-state-update calls + Safe TX hash; output as JSON (no signing, no posting). <path> is a generated `.yaml` file or a directory (walked recursively — only generated files with a sibling `.zac.yaml` are planned). Output is written alongside each generated file as `<stem>.plan.json`.',
    )
    .option(
      '--rpc-url <url>',
      'RPC URL for chain reads (Safe nonce, role state); overrides RPC_URL env',
    )
    .action(async (inputPath: string, options: { rpcUrl?: string }) => {
      const { runPlan } = await import('./apply/runPlan');
      const { serializePlan } = await import('./apply/planSchema');
      const generated = findGeneratedConfigs(inputPath);
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
      'sign + post plan JSON files to Safe Transaction Service (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY, RPC_URL). <path> is a `.plan.json` file or a directory (walked recursively).',
    )
    .action(async (inputPath: string) => {
      const { runSubmit } = await import('./apply/runSubmit');
      const { parsePlan } = await import('./apply/planSchema');
      const proposerKey = process.env['ZAC_PROPOSER_PRIVATE_KEY'] as `0x${string}` | undefined;
      if (proposerKey === undefined) {
        throw new ZacError({
          phase: 'apply',
          message: 'ZAC_PROPOSER_PRIVATE_KEY env var is required for submit',
        });
      }
      const plans = findPlans(inputPath);
      const { ok } = await runBatch(plans, 'submit', async (planPath) => {
        const plan = parsePlan(readFileSync(planPath, 'utf8'));
        const submitArgs: Parameters<typeof runSubmit>[0] = {
          plan,
          proposerPrivateKey: proposerKey,
        };
        const apiKey = process.env['SAFE_API_KEY'];
        if (apiKey !== undefined) submitArgs.apiKey = apiKey;
        const rpcUrl = process.env['RPC_URL'];
        if (rpcUrl !== undefined) submitArgs.rpcUrl = rpcUrl;
        const result = await runSubmit(submitArgs);
        process.stdout.write(
          `submitted ${displayPath(planPath)}: safeTxHash ${result.safeTxHash}\n`,
        );
      });
      if (!ok) {
        throw new ZacError({ phase: 'apply', message: 'one or more submit steps failed' });
      }
    });

  program
    .command('apply <path>')
    .description(
      'propose role state updates as Safe transactions (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY, RPC_URL). <path> is a generated `.yaml` file or a directory (walked recursively — only generated files with a sibling `.zac.yaml` are applied).',
    )
    .option(
      '--rpc-url <url>',
      'RPC URL for chain reads (Safe nonce, role state); overrides RPC_URL env',
    )
    .action(async (inputPath: string, options: { rpcUrl?: string }) => {
      const { runApply } = await import('./apply/runApply');
      const generated = findGeneratedConfigs(inputPath);
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
