import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ZacError } from '../errors';

export function writeOutput(content: string, outPath?: string): void {
  if (outPath === undefined) {
    process.stdout.write(content);
    return;
  }
  if (existsSync(outPath) && statSync(outPath).isDirectory()) {
    throw new ZacError({
      phase: 'emit',
      message: `--out path is an existing directory: ${outPath}`,
    });
  }
  const parent = dirname(outPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(outPath, content, 'utf8');
}
