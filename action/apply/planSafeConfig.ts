import { ZacError } from '../errors';
import type { ParsedSafeYaml } from '../validate/safeConfigSchema';
import type { Call } from './planRoleCalls';
import type { SafeLike, SafeTransactionLike } from './safeApi';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function isZero(a: string): boolean {
  return a.toLowerCase() === ZERO_ADDRESS;
}

export interface PlanSafeConfigOpts {
  safeYaml: ParsedSafeYaml;
  safe: SafeLike;
  safeAddress: string;
  /**
   * Roles modifiers declared by sibling `.zac.yaml` files in the safe-dir.
   * Used to cross-validate that every declared modifier appears in
   * `safeYaml.modules` (when modules is managed); the `sourceFile` is the
   * `.zac.yaml` path to name in the error. Pass `[]` in safe-only safe-dirs.
   */
  declaredModifiers: Array<{ address: string; sourceFile: string }>;
}

/**
 * Compute the Safe-level reconcile calls (setGuard / setFallbackHandler /
 * enableModule / disableModule) for a single safe-dir.
 *
 * Cross-validation runs BEFORE any live-state read or call generation:
 * when `safeYaml.modules` is managed, every declared modifier address from
 * sibling `.zac.yaml` files must appear in the filtered `modules` list
 * (post-`0x0` filter). A mismatch is `phase=validate` and names the
 * offending source.
 *
 * Live state is read in parallel via `Promise.all` over `getGuard`,
 * `getFallbackHandler`, `getModules`. Missing methods on the injected
 * `SafeLike` throw `ZacError(phase='apply', 'internal: Safe instance missing <method>')`.
 *
 * Output ordering is: disables → enables → setGuard → setFallbackHandler.
 * All Call entries `to == safeAddress` with `value == '0'`.
 */
export async function planSafeConfig(opts: PlanSafeConfigOpts): Promise<Call[]> {
  // 1. Cross-validation (before any RPC traffic).
  if (opts.safeYaml.modules !== null) {
    const desiredLowered = new Set(
      opts.safeYaml.modules.filter((m) => !isZero(m)).map((m) => m.toLowerCase()),
    );
    for (const dm of opts.declaredModifiers) {
      if (!desiredLowered.has(dm.address.toLowerCase())) {
        throw new ZacError({
          phase: 'validate',
          message: `safe.yaml modules: [${opts.safeYaml.modules.join(', ')}] does not include the roles modifier ${dm.address} declared by ${dm.sourceFile}`,
        });
      }
    }
  }

  // 2. Live-state reads in parallel — guarded by presence-of-method on the
  //    SafeLike stub. The optional methods exist for test ergonomics; in
  //    production protocol-kit's Safe always provides them.
  if (opts.safe.getGuard === undefined) {
    throw new ZacError({ phase: 'apply', message: 'internal: Safe instance missing getGuard' });
  }
  if (opts.safe.getFallbackHandler === undefined) {
    throw new ZacError({
      phase: 'apply',
      message: 'internal: Safe instance missing getFallbackHandler',
    });
  }
  if (opts.safe.getModules === undefined) {
    throw new ZacError({ phase: 'apply', message: 'internal: Safe instance missing getModules' });
  }

  const [liveGuard, liveFallback, liveModules] = await Promise.all([
    opts.safe.getGuard(),
    opts.safe.getFallbackHandler(),
    opts.safe.getModules(),
  ]);

  // 3. Bucket calls into the four kinds, ordered: disables → enables →
  //    setGuard → setFallbackHandler.
  const disables: Call[] = [];
  const enables: Call[] = [];
  const setGuardCalls: Call[] = [];
  const setFallbackCalls: Call[] = [];

  // 3a. modules reconcile (only when managed).
  if (opts.safeYaml.modules !== null) {
    const desired = new Set(
      opts.safeYaml.modules.filter((m) => !isZero(m)).map((m) => m.toLowerCase()),
    );
    const live = new Set(liveModules.map((m) => m.toLowerCase()));
    const toDisable = [...live].filter((m) => !desired.has(m));
    const toEnable = [...desired].filter((m) => !live.has(m));
    for (const m of toDisable) {
      if (opts.safe.createDisableModuleTx === undefined) {
        throw new ZacError({
          phase: 'apply',
          message: 'internal: Safe instance missing createDisableModuleTx',
        });
      }
      const tx = await opts.safe.createDisableModuleTx(m);
      disables.push(callFromTx(tx));
    }
    for (const m of toEnable) {
      if (opts.safe.createEnableModuleTx === undefined) {
        throw new ZacError({
          phase: 'apply',
          message: 'internal: Safe instance missing createEnableModuleTx',
        });
      }
      const tx = await opts.safe.createEnableModuleTx(m);
      enables.push(callFromTx(tx));
    }
  }

  // 3b. guard. Symmetric to `fallback`: the EXPLICIT zero address is a
  //     real op — emits `setGuard(0x0)` to CLEAR the on-chain guard. Only
  //     `null` (YAML `~`) means "don't manage". The inequality guard
  //     implicitly skips when desired matches live (incl. desired=0x0
  //     already cleared on-chain).
  if (opts.safeYaml.guard !== null) {
    const desiredGuard = opts.safeYaml.guard;
    if (liveGuard.toLowerCase() !== desiredGuard.toLowerCase()) {
      if (isZero(desiredGuard)) {
        if (opts.safe.createDisableGuardTx === undefined) {
          throw new ZacError({
            phase: 'apply',
            message: 'internal: Safe instance missing createDisableGuardTx',
          });
        }
        const tx = await opts.safe.createDisableGuardTx();
        setGuardCalls.push(callFromTx(tx));
      } else {
        if (opts.safe.createEnableGuardTx === undefined) {
          throw new ZacError({
            phase: 'apply',
            message: 'internal: Safe instance missing createEnableGuardTx',
          });
        }
        const tx = await opts.safe.createEnableGuardTx(desiredGuard);
        setGuardCalls.push(callFromTx(tx));
      }
    }
  }

  // 3c. fallback. Same shape as the guard branch: explicit zero clears
  //     the on-chain fallback handler via `setFallbackHandler(0x0)`; only
  //     `~` (null) skips the slot.
  if (opts.safeYaml.fallback !== null) {
    const desiredFallback = opts.safeYaml.fallback;
    if (liveFallback.toLowerCase() !== desiredFallback.toLowerCase()) {
      if (isZero(desiredFallback)) {
        if (opts.safe.createDisableFallbackHandlerTx === undefined) {
          throw new ZacError({
            phase: 'apply',
            message: 'internal: Safe instance missing createDisableFallbackHandlerTx',
          });
        }
        const tx = await opts.safe.createDisableFallbackHandlerTx();
        setFallbackCalls.push(callFromTx(tx));
      } else {
        if (opts.safe.createEnableFallbackHandlerTx === undefined) {
          throw new ZacError({
            phase: 'apply',
            message: 'internal: Safe instance missing createEnableFallbackHandlerTx',
          });
        }
        const tx = await opts.safe.createEnableFallbackHandlerTx(desiredFallback);
        setFallbackCalls.push(callFromTx(tx));
      }
    }
  }

  return [...disables, ...enables, ...setGuardCalls, ...setFallbackCalls];
}

/**
 * Pull the `{to, value, data}` triple off a protocol-kit transaction.
 * Drops `operation` (always CALL=0 for these 4 builders; downstream
 * MultiSend wrapping refills as needed).
 */
function callFromTx(tx: SafeTransactionLike): Call {
  return { to: tx.data.to, value: tx.data.value, data: tx.data.data };
}
