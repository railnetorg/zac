export type ZacPhase = 'load' | 'render' | 'parse' | 'validate' | 'emit';

export interface SourceLocation {
  file: string;
  line?: number;
  col?: number;
}

export class ZacError extends Error {
  readonly phase: ZacPhase;
  readonly sourceLocation?: SourceLocation;

  constructor(opts: { phase: ZacPhase; message: string; sourceLocation?: SourceLocation }) {
    super(opts.message);
    this.name = 'ZacError';
    this.phase = opts.phase;
    if (opts.sourceLocation !== undefined) {
      this.sourceLocation = opts.sourceLocation;
    }
  }
}

export interface FormatErrorOpts {
  stderr?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
}

export function formatError(err: ZacError, opts: FormatErrorOpts = {}): string {
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  const useColor = Boolean(stderr.isTTY) && env.NO_COLOR === undefined;

  const RED = useColor ? '\x1b[31m' : '';
  const RESET = useColor ? '\x1b[0m' : '';

  const loc = err.sourceLocation;
  const locStr = loc
    ? loc.line !== undefined
      ? loc.col !== undefined
        ? ` ${loc.file}:${loc.line}:${loc.col}`
        : ` ${loc.file}:${loc.line}`
      : ` ${loc.file}`
    : '';

  return `${RED}phase=${err.phase}${locStr}: ${err.message}${RESET}`;
}
