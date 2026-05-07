import nunjucks from 'nunjucks';
import { keccak256, toBytes } from 'viem';

/** Build a Nunjucks environment for rendering ALIAS files specifically. No aliases global. */
export function makeAliasEnv(): nunjucks.Environment {
  const env = new nunjucks.Environment(undefined, { throwOnUndefined: true });
  env.addFilter('keccak', (s: string) => keccak256(toBytes(s)));
  return env;
}
