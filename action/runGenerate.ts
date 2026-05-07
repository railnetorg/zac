import { ZacError } from './errors';

export interface RunGenerateOpts {
  configPath: string;
  outPath?: string;
  configOverride?: string;
}

export async function runGenerate(opts: RunGenerateOpts): Promise<void> {
  // Stub: real pipeline lands in phases 3-8.
  throw new ZacError({
    phase: 'load',
    message: `runGenerate is not yet implemented; called with configPath=${opts.configPath}`,
  });
}
