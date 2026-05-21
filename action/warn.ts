export interface WarnOpts {
  stderr?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

export function warn(message: string, opts: WarnOpts = {}): void {
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;
  const useColor = Boolean(stderr.isTTY) && env.NO_COLOR === undefined;

  const YELLOW = useColor ? '\x1b[33m' : '';
  const RESET = useColor ? '\x1b[0m' : '';

  stderr.write(`${YELLOW}WARN: ${message}${RESET}\n`);
}
