import { ZacError } from '../errors';
import { parseGenerated } from './parseGenerated';
import { planRoleCalls, type PlanApplyRoleFn } from './planRoleCalls';
import { proposeToSafe, type SafeInitFn, type SafeApiKitCtor } from './safeApi';

export interface RunApplyOpts {
  generatedPath: string;
  /** Defaults to `process.env.ZAC_PROPOSER_PRIVATE_KEY`. */
  proposerPrivateKey?: `0x${string}`;
  /** Defaults to `process.env.SAFE_API_KEY` (forwarded only if set). */
  apiKey?: string;
  /** Defaults to `process.env.RPC_URL` (forwarded only if set). */
  rpcUrl?: string;
  /** Injected SDK fn — forwarded to planRoleCalls. */
  planApplyRole?: PlanApplyRoleFn;
  /** Injected SDK fn — forwarded to planRoleCalls. */
  encodeKey?: (key: string) => `0x${string}`;
  /** Injected — forwarded to proposeToSafe. */
  safeInit?: SafeInitFn;
  /** Injected — forwarded to proposeToSafe. */
  apiKitCtor?: SafeApiKitCtor;
}

export async function runApply(opts: RunApplyOpts): Promise<{ safeTxHash: string }> {
  const proposerKey =
    opts.proposerPrivateKey ??
    (process.env['ZAC_PROPOSER_PRIVATE_KEY'] as `0x${string}` | undefined);
  if (proposerKey === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: 'ZAC_PROPOSER_PRIVATE_KEY env var is required for apply',
    });
  }
  const apiKey = opts.apiKey ?? process.env['SAFE_API_KEY'];
  const rpcUrl = opts.rpcUrl ?? process.env['RPC_URL'];

  const generated = parseGenerated(opts.generatedPath);

  const planArgs: Parameters<typeof planRoleCalls>[0] = { generated };
  if (opts.planApplyRole !== undefined) planArgs.planApplyRole = opts.planApplyRole;
  if (opts.encodeKey !== undefined) planArgs.encodeKey = opts.encodeKey;
  const calls = await planRoleCalls(planArgs);

  if (calls.length === 0) {
    throw new ZacError({
      phase: 'apply',
      message: 'planApplyRole returned 0 calls — role state is already in sync, nothing to propose',
    });
  }

  const proposeArgs: Parameters<typeof proposeToSafe>[0] = {
    chainId: generated.deployment.chain_id,
    safeAddress: generated.deployment.safe_address,
    calls,
    proposerPrivateKey: proposerKey,
  };
  if (apiKey !== undefined) proposeArgs.apiKey = apiKey;
  if (rpcUrl !== undefined) proposeArgs.rpcUrl = rpcUrl;
  if (opts.safeInit !== undefined) proposeArgs.safeInit = opts.safeInit;
  if (opts.apiKitCtor !== undefined) proposeArgs.apiKitCtor = opts.apiKitCtor;

  return proposeToSafe(proposeArgs);
}
