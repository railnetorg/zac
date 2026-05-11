#!/usr/bin/env bun
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { ZacError, formatError } from './errors';
import { runGenerate } from './runGenerate';

declare const Bun: { main: string } | undefined;

interface BunImportMeta extends ImportMeta {
  path?: string;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name('zac').description('Zodiac Roles V2 config generator').exitOverride();

  program
    .command('generate <config_path>')
    .description('generate a Zodiac Roles V2 config from a deployment YAML')
    .option('--out <path>', 'write rendered output to a file (default: stdout)')
    .option('--config <path>', 'override path to root config.yaml (default: walk up)')
    .action(async (configPath: string, options: { out?: string; config?: string }) => {
      const opts: { configPath: string; outPath?: string; configOverride?: string } = {
        configPath,
      };
      if (options.out !== undefined) opts.outPath = options.out;
      if (options.config !== undefined) opts.configOverride = options.config;
      await runGenerate(opts);
    });

  program
    .command('plan <generated_path>')
    .description(
      'compute role-state-update calls + Safe TX hash; output as JSON (no signing, no posting)',
    )
    .option('--out <path>', 'write plan JSON to a file (default: stdout)')
    .action(async (generatedPath: string, options: { out?: string }) => {
      const { runPlan } = await import('./apply/runPlan');
      const { serializePlan } = await import('./apply/planSchema');
      const plan = await runPlan({ generatedPath });
      const json = serializePlan(plan);
      if (options.out !== undefined) {
        writeFileSync(options.out, json);
      } else {
        process.stdout.write(json + '\n');
      }
    });

  program
    .command('submit <plan_path>')
    .description(
      'sign + post a plan JSON to Safe Transaction Service (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY, RPC_URL)',
    )
    .action(async (planPath: string) => {
      const { runSubmit } = await import('./apply/runSubmit');
      const { parsePlan } = await import('./apply/planSchema');
      const proposerKey = process.env['ZAC_PROPOSER_PRIVATE_KEY'] as `0x${string}` | undefined;
      if (proposerKey === undefined) {
        throw new ZacError({
          phase: 'apply',
          message: 'ZAC_PROPOSER_PRIVATE_KEY env var is required for submit',
        });
      }
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
      process.stdout.write(`safeTxHash: ${result.safeTxHash}\n`);
    });

  program
    .command('apply <generated_path>')
    .description(
      'propose role state updates as a Safe transaction (signed by ZAC_PROPOSER_PRIVATE_KEY env var; optional SAFE_API_KEY, RPC_URL)',
    )
    .action(async (generatedPath: string) => {
      const { runApply } = await import('./apply/runApply');
      const result = await runApply({ generatedPath });
      process.stdout.write(`safeTxHash: ${result.safeTxHash}\n`);
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
