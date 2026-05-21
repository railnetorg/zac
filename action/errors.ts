export type ZacPhase = 'load' | 'render' | 'parse' | 'validate' | 'emit' | 'apply';

export interface SourceLocation {
  file: string;
  line?: number;
  col?: number;
}

export interface TemplateLocation {
  file: string;
  line: number | null;
  note?: string;
}

export class ZacError extends Error {
  readonly phase: ZacPhase;
  readonly sourceLocation?: SourceLocation;
  readonly templateLocation?: TemplateLocation;

  constructor(opts: {
    phase: ZacPhase;
    message: string;
    sourceLocation?: SourceLocation;
    templateLocation?: TemplateLocation;
  }) {
    super(opts.message);
    this.name = 'ZacError';
    this.phase = opts.phase;
    if (opts.sourceLocation !== undefined) {
      this.sourceLocation = opts.sourceLocation;
    }
    if (opts.templateLocation !== undefined) {
      this.templateLocation = opts.templateLocation;
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

  let locStr = '';
  let trailingNote = '';
  const tloc = err.templateLocation;
  const sloc = err.sourceLocation;

  if (tloc && tloc.line !== null) {
    locStr = ` ${tloc.file}:${tloc.line}`;
  } else if (tloc && tloc.line === null) {
    // Fallback to sourceLocation, append note.
    if (sloc) {
      locStr = formatSourceLoc(sloc);
    }
    if (tloc.note !== undefined) {
      trailingNote = ` (${tloc.note})`;
    }
  } else if (sloc) {
    locStr = formatSourceLoc(sloc);
  }

  return `${RED}phase=${err.phase}${locStr}: ${err.message}${trailingNote}${RESET}`;
}

function formatSourceLoc(loc: SourceLocation): string {
  if (loc.line !== undefined) {
    if (loc.col !== undefined) return ` ${loc.file}:${loc.line}:${loc.col}`;
    return ` ${loc.file}:${loc.line}`;
  }
  return ` ${loc.file}`;
}
