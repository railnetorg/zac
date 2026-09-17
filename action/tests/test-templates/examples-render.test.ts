import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGenerate } from '../../runGenerate';
import { parseGenerated } from '../../apply/parseGenerated';
import { parseAndValidateSafeYaml } from '../../validate/safeConfigSchema';
import { loadAllAliases } from '../../load/loadAllAliases';
import { networkForDirectory } from '../../load/networkTable';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const EXAMPLES = resolve(REPO_ROOT, 'examples');

/**
 * Every `*.zac.yaml` under `examples/`, as repo-relative paths, sorted.
 *
 * Enumerated rather than listed: the other tests that touch `examples/`
 * name one or two files each, so an example nobody named could stop
 * rendering and ship green. The render environment runs
 * `throwOnUndefined`, which makes every new required template param an
 * immediate break in every config that does not declare it — the thing
 * this walk is here to catch.
 */
function findExamples(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...findExamples(full, match));
    else if (match(entry.name)) out.push(relative(REPO_ROOT, full));
  }
  return out.sort();
}

const SOURCES = findExamples(EXAMPLES, (n) => n.endsWith('.zac.yaml'));
const SAFE_YAMLS = findExamples(EXAMPLES, (n) => n === 'safe.yaml');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-examples-render-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('examples/**/*.zac.yaml', () => {
  it('the walk finds sources — an empty list would make every case below vacuous', () => {
    expect(SOURCES.length).toBeGreaterThan(0);
  });

  // One case per file so a failure names the file in the test title itself.
  // `runGenerate` is the same entry point `zac generate` calls, so the walk
  // exercises the real load → render → parse → validate → emit path
  // (curated aliases, the `config.yaml` walk-up, the layout checks) rather
  // than a render environment assembled for the test. Output goes to a temp
  // dir so a run leaves no `*.yaml` behind next to the sources.
  //
  // Render-and-parse only, on purpose: planning needs a chain and a Safe,
  // and render-time breakage is what ships silently.
  it.each(SOURCES)('%s renders and parses as a generated config', async (source) => {
    const outPath = join(makeTempDir(), basename(source).replace(/\.zac\.yaml$/, '.yaml'));
    await runGenerate({ configPath: resolve(REPO_ROOT, source), outPath });
    const generated = parseGenerated(outPath);
    // A config that renders to no roles at all is a template or param
    // regression that `parseGenerated` alone would accept.
    expect(Object.keys(generated.roles).length).toBeGreaterThan(0);
  });
});

describe('examples/**/safe.yaml', () => {
  it('the walk finds safe.yaml files', () => {
    expect(SAFE_YAMLS.length).toBeGreaterThan(0);
  });

  // `safe.yaml` is rendered before it is parsed, exactly like a `*.zac.yaml`,
  // but only on the plan/submit path — `zac generate` never reads it. So the
  // walk above cannot reach it, and nothing else did: all three shipped files
  // documented the alias syntax with live `{{ … }}` expressions in their
  // comments, which nunjucks evaluates like any other. The first one was a
  // syntax error and the second an undefined lookup, and both surfaced only
  // when someone copied the file into a repository and ran a real plan.
  it.each(SAFE_YAMLS)('%s renders and validates', (source) => {
    const path = resolve(REPO_ROOT, source);
    const network = basename(resolve(path, '../..'));
    expect(networkForDirectory(network)).not.toBeNull();
    const aliases = loadAllAliases({ configPath: resolve(EXAMPLES, 'config.yaml'), network });
    const parsed = parseAndValidateSafeYaml({
      path,
      network,
      configDir: EXAMPLES,
      aliases: aliases.merged,
    });
    // The shipped files are the all-`~` opt-out. A key that stopped being `~`
    // would silently start planning Safe-level calls for anyone who copied it.
    expect(parsed.guard).toBeNull();
    expect(parsed.fallback).toBeNull();
    expect(parsed.modules).toBeNull();
  });
});
