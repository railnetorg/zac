import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGenerate } from '../../runGenerate';
import { parseGenerated } from '../../apply/parseGenerated';

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
function findExampleSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...findExampleSources(full));
    else if (entry.name.endsWith('.zac.yaml')) out.push(relative(REPO_ROOT, full));
  }
  return out.sort();
}

const SOURCES = findExampleSources(EXAMPLES);

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
