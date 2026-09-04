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
 * Parsed-and-validated `safe.yaml` content. The `guard`, `fallback`, and
 * `modules` fields are REQUIRED in the source file; `null` (the YAML `~`
 * shorthand) means "don't manage this slot" (no call emitted at plan
 * time). `nestedSigners` is OPTIONAL in the source file and always
 * NORMALIZED here to a `string[]` (empty `[]` when the key is absent or
 * `~`); each address is lowercased and deduped.
 *
 * Per-field zero-address semantics:
 * - `guard`: zero address is EXPLICIT — when live is non-zero the plan
 *    emits `setGuard(0x0)` to clear the on-chain guard; when live is
 *    already zero the inequality guard short-circuits. Use `~` (null) if
 *    you don't want zac to touch the guard at all.
 * - `fallback`: same as `guard` — zero address is EXPLICIT, emits
 *    `setFallbackHandler(0x0)` to clear the on-chain fallback handler;
 *    use `~` (null) to leave the slot untouched.
 * - `modules`: zero address is filtered out before set-diffing.
 *
 * `nestedSigners` carries parent-Safe owners that are THEMSELVES Safes;
 * it never produces a plan call — it is safe-level metadata surfaced as a
 * nested-signer signing-hash preview at plan time and emitted at submit.
 */
export interface ParsedSafeYaml {
  guard: string | null;
  fallback: string | null;
  modules: string[] | null;
  nestedSigners: string[];
}

/**
 * Strict: `nested_signers` is the optional key, so a misspelling of it is
 * accepted, normalized to `[]`, and drops the nested-signer signing-hash
 * preview without saying anything. The required three fail loudly on their
 * own (step 4 below), but a `guar:` typo alongside them would otherwise sit in
 * the file looking like it manages the guard slot.
 */
export const SafeConfigSchema = z
  .object({
    guard: z.union([z.null(), AddressString]),
    fallback: z.union([z.null(), AddressString]),
    modules: z.union([z.null(), z.array(AddressString)]),
    nested_signers: z.union([z.null(), z.array(AddressString)]).optional(),
  })
  .strict();

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
 * - `phase=validate`: missing required key, invalid address, duplicate
 *   non-zero module after the `0x0` filter, or invalid/duplicate
 *   `nested_signers` address.
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
    // An unrecognized key is reported against the mapping that holds it, so
    // it has no path to key the per-field branches below off. The zod message
    // already names the key; the allowed set is what tells the author what
    // they meant to write.
    if (issue.code === 'unrecognized_keys') {
      throw new ZacError({
        phase: 'validate',
        message: `safe.yaml: ${issue.message} — allowed: ${Object.keys(SafeConfigSchema.shape).join(', ')}`,
        sourceLocation: { file: opts.path },
      });
    }
    const key = issue.path[0];
    const keyStr = typeof key === 'string' ? key : String(key);
    // Distinguish "invalid address" from other zod errors with a stable
    // user-facing message format.
    const got = obj[keyStr];
    const isAddrField = keyStr === 'guard' || keyStr === 'fallback';
    if (isAddrField && typeof got === 'string') {
      throw new ZacError({
        phase: 'validate',
        message: `safe.yaml: '${keyStr}': invalid address '${got}'`,
        sourceLocation: { file: opts.path },
      });
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
    if (keyStr === 'nested_signers' && Array.isArray(got)) {
      // Mirror the `modules` branch — surface the first non-address element.
      const badIdx = issue.path[1];
      const badVal =
        typeof badIdx === 'number' && badIdx < got.length ? String(got[badIdx]) : '<unknown>';
      throw new ZacError({
        phase: 'validate',
        message: `safe.yaml: 'nested_signers': invalid address '${badVal}'`,
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
  if (parsed.data.modules !== null) {
    const filtered = parsed.data.modules.filter((m) => m.toLowerCase() !== ZERO_ADDRESS);
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

  // 7. Normalize `nested_signers` to a lowercased, deduped `string[]`
  //    (empty when the key is absent or `~`). Mirrors how `modules` is
  //    handled — reject duplicates. No `0x0` filter: a nested signer is a
  //    real Safe owner, not a managed slot.
  const nestedSigners: string[] = [];
  const rawNested = parsed.data.nested_signers;
  if (rawNested !== null && rawNested !== undefined) {
    const seenNested = new Set<string>();
    for (const s of rawNested) {
      const lo = s.toLowerCase();
      if (seenNested.has(lo)) {
        throw new ZacError({
          phase: 'validate',
          message: `safe.yaml: nested_signers contains duplicate '${s}'`,
          sourceLocation: { file: opts.path },
        });
      }
      seenNested.add(lo);
      nestedSigners.push(lo);
    }
  }

  // Map the snake_case source key to the normalized `nestedSigners` field —
  // never leak `nested_signers` into the returned `ParsedSafeYaml`.
  return {
    guard: parsed.data.guard,
    fallback: parsed.data.fallback,
    modules: parsed.data.modules,
    nestedSigners,
  };
}
