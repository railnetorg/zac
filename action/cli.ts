#!/usr/bin/env bun
import { Command } from 'commander';
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
