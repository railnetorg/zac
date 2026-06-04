import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAddress } from 'viem';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ZacError } from '../errors';
import { makeConfigEnv } from '../render/configEnv';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const AddressString = z.string().refine((s) => isAddress(s), {
  message: 'must be a valid Ethereum address',
});

/**
 * Parsed-and-validated `safe.yaml` content. All three fields are
 * REQUIRED in the source file; `null` (the YAML `~` shorthand) means
 * "don't manage this slot" (no call emitted at plan time).
 *
 * Per-field zero-address semantics:
 * - `guard`: zero address (bare-string form) is EXPLICIT — when live is
 *    non-zero the plan emits `setGuard(0x0)` to clear the on-chain guard;
 *    when live is already zero the inequality guard short-circuits. Use
 *    `~` (null) if you don't want zac to touch the guard at all.
 * - `fallback`: same as `guard` — zero address is EXPLICIT, emits
 *    `setFallbackHandler(0x0)` to clear the on-chain fallback handler;
 *    use `~` (null) to leave the slot untouched.
 * - `modules`: zero address is filtered out before set-diffing.
 *
 * `guard` accepts two source forms (always normalized to the object form here):
 *   guard: 0xABCD...
 *   guard: { address: 0xABCD..., timelock_delay: 86400 }
 * When `timelockDelay` is set, the guard is expected to be a TimelockGuard
 * (or compatible) — `planSafeConfig` will batch a `configureTimelockGuard`
 * call alongside `setGuard` to avoid a zero-delay window.
 */
export interface ParsedSafeYaml {
  guard: ParsedGuard | null;
  fallback: string | null;
  modules: string[] | null;
}

export interface ParsedGuard {
  address: string;
  /** Timelock delay in seconds; only set when the source used the object form with `timelock_delay`. */
  timelockDelay?: number;
}

const GuardObjectSchema = z
  .object({
    address: AddressString,
    timelock_delay: z.number().int().positive(),
  })
  .strict();

export const SafeConfigSchema = z.object({
  guard: z.union([z.null(), AddressString, GuardObjectSchema]),
  fallback: z.union([z.null(), AddressString]),
  modules: z.union([z.null(), z.array(AddressString)]),
});

export interface ParseAndValidateSafeYamlOpts {
  /** Absolute path to the `safe.yaml` file. */
  path: string;
  /** Merged alias registry — exposed as the `aliases` global in nunjucks. */
  aliases: Record<string, unknown>;
  /** Directory containing the root `config.yaml` (extra nunjucks search path). */
  configDir: string;
  /**
   * Network directory name (e.g. `'mainnet'`) — currently unused at parse
   * time but kept on the signature for symmetry with sibling loaders /
   * future per-network template scoping.
   */
  network: string;
}

/**
 * Read, render (nunjucks), parse (YAML), and validate (zod) the `safe.yaml`
 * at `opts.path`. Throws `ZacError` at each phase:
 *
 * - `phase=load`: file not found.
 * - `phase=render`: nunjucks render error (e.g. unresolved `{{ aliases.foo }}`).
 * - `phase=parse`: YAML parse error or empty document.
 * - `phase=validate`: missing required key, invalid address, or duplicate
 *   non-zero module after the `0x0` filter.
 */
export function parseAndValidateSafeYaml(opts: ParseAndValidateSafeYamlOpts): ParsedSafeYaml {
  // 1. Read.
  if (!existsSync(opts.path)) {
    throw new ZacError({
      phase: 'load',
      message: `safe.yaml not found in ${dirname(opts.path)}`,
    });
  }
  const raw = readFileSync(opts.path, 'utf8');

  // 2. Render via the SAME nunjucks env config the deployment configs use
  //    (search paths: configDir + safe.yaml's dir; aliases global wired).
  const env = makeConfigEnv({
    searchPaths: [opts.configDir, dirname(opts.path)],
    aliases: opts.aliases,
  });
  let rendered: string;
  try {
    rendered = env.renderString(raw, {});
  } catch (err) {
    throw new ZacError({
      phase: 'render',
      message: `safe.yaml render failed: ${err instanceof Error ? err.message : String(err)}`,
      sourceLocation: { file: opts.path },
    });
  }

  // 3. Parse YAML.
  const doc = parseDocument(rendered);
  if (doc.errors.length > 0) {
    throw new ZacError({
      phase: 'parse',
      message: `safe.yaml YAML parse failed: ${doc.errors[0]!.message}`,
      sourceLocation: { file: opts.path },
    });
  }
  const json = doc.toJSON();
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ZacError({
      phase: 'parse',
      message: `safe.yaml must be a YAML mapping at the top level (got ${
        json === null ? 'null/empty' : Array.isArray(json) ? 'array' : typeof json
      })`,
      sourceLocation: { file: opts.path },
    });
  }
  const obj = json as Record<string, unknown>;

  // 4. Required-key check — explicit message so users immediately know
  //    `~` is the way to opt out of management.
  for (const key of ['guard', 'fallback', 'modules'] as const) {
    if (!(key in obj)) {
      throw new ZacError({
        phase: 'validate',
        message: `safe.yaml: '${key}' is required (use ~ for don't-manage)`,
        sourceLocation: { file: opts.path },
      });
    }
  }

  // 5. Zod parse — surfaces invalid addresses / wrong types with the
  //    matrix-spec'd message.
  const parsed = SafeConfigSchema.safeParse(obj);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const key = issue.path[0];
    const keyStr = typeof key === 'string' ? key : String(key);
    // Distinguish "invalid address" from other zod errors with a stable
    // user-facing message format.
    const got = obj[keyStr];
    if (keyStr === 'fallback' && typeof got === 'string') {
      throw new ZacError({
        phase: 'validate',
        message: `safe.yaml: 'fallback': invalid address '${got}'`,
        sourceLocation: { file: opts.path },
      });
    }
    if (keyStr === 'guard') {
      // Bare-address form failure: emit the legacy `invalid address` message
      // for compatibility with tests / docs. Object-form failures fall through
      // to the generic zod message (which names the bad sub-key).
      if (typeof got === 'string') {
        throw new ZacError({
          phase: 'validate',
          message: `safe.yaml: 'guard': invalid address '${got}'`,
          sourceLocation: { file: opts.path },
        });
      }
    }
    if (keyStr === 'modules' && Array.isArray(got)) {
      // Find the first non-address element for the message.
      const badIdx = issue.path[1];
      const badVal =
        typeof badIdx === 'number' && badIdx < got.length ? String(got[badIdx]) : '<unknown>';
      throw new ZacError({
        phase: 'validate',
        message: `safe.yaml: 'modules': invalid address '${badVal}'`,
        sourceLocation: { file: opts.path },
      });
    }
    throw new ZacError({
      phase: 'validate',
      message: `safe.yaml: '${keyStr}': ${issue.message}`,
      sourceLocation: { file: opts.path },
    });
  }

  // 6. Post-parse: enforce no duplicate modules after the `0x0` filter.
  const modules: string[] | null = parsed.data.modules;
  if (modules !== null) {
    const filtered = modules.filter((m: string) => m.toLowerCase() !== ZERO_ADDRESS);
    const seen = new Set<string>();
    for (const m of filtered) {
      const lo = m.toLowerCase();
      if (seen.has(lo)) {
        throw new ZacError({
          phase: 'validate',
          message: `safe.yaml: modules contains duplicate '${m}'`,
          sourceLocation: { file: opts.path },
        });
      }
      seen.add(lo);
    }
  }

  // 7. Normalize the guard value to the canonical `ParsedGuard` object form,
  //    or null. Bare-address input becomes `{ address }`.
  const rawGuard = parsed.data.guard;
  let guard: ParsedGuard | null;
  if (rawGuard === null) {
    guard = null;
  } else if (typeof rawGuard === 'string') {
    guard = { address: rawGuard };
  } else {
    guard = { address: rawGuard.address, timelockDelay: rawGuard.timelock_delay };
  }

  return {
    guard,
    fallback: parsed.data.fallback,
    modules,
  };
}
