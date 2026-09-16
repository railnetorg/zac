import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { makeConfigEnv } from '../../render/configEnv';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const TEMPLATES_DIR = resolve(REPO_ROOT, 'templates');

const DISTRIBUTOR = '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae';

/**
 * merkl.tmpl has no params and no branching — the whole policy is one function on one
 * target with every parameter `pass`. What deserves tests is exactly that flatness: the
 * template's safety rests on target + selector pinning plus deliberate omissions (see its
 * header), so the render must contain the single `claim` grant and NOTHING else — no
 * `claimWithRecipient`, no `setClaimRecipient`, no `toggleOperator`. A future edit that
 * "helpfully" adds one of those must turn this suite red.
 *
 * Rendering goes through `makeConfigEnv`, the builder the CLI itself uses.
 */
describe('merkl/merkl.tmpl', () => {
  const env = makeConfigEnv({
    searchPaths: [TEMPLATES_DIR],
    aliases: {
      merkl: { distributor: DISTRIBUTOR },
    },
  });

  const render = (): string => env.render('merkl/merkl.tmpl', {});

  /** The `roles[]` entries, as `{ address, functions }`, in emitted order. */
  const roles = (
    out: string,
  ): Array<{
    address: string;
    functions: Array<{
      signature: string;
      execution_options: string;
      params: Array<Record<string, unknown>>;
    }>;
  }> => {
    const doc = parseDocument(out);
    expect(doc.errors).toEqual([]);
    return (doc.toJSON() as { roles: Array<never> }).roles;
  };

  it('emits exactly one target: the aliased distributor', () => {
    const out = roles(render());
    expect(out).toHaveLength(1);
    expect(out[0]!.address).toBe(DISTRIBUTOR);
  });

  it('grants exactly one function — claim — with every parameter pass and no execution surface', () => {
    const fns = roles(render())[0]!.functions;
    expect(fns).toHaveLength(1);
    const claim = fns[0]!;
    expect(claim.signature).toBe(
      'function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)',
    );
    expect(claim.execution_options).toBe('none');
    expect(claim.params.map((p) => p['name'])).toEqual(['users', 'tokens', 'amounts', 'proofs']);
    for (const p of claim.params) {
      expect(p['param_type'], `${String(p['name'])} param_type`).toBe('dynamic');
      expect(p['operator'], `${String(p['name'])} operator`).toBe('pass');
      // `pass` takes no comparison value — a value here would mean the operator changed.
      expect(p['value'], `${String(p['name'])} carries a value`).toBeUndefined();
    }
  });

  it('never emits the redirection vectors the header promises to omit', () => {
    const out = render();
    expect(out).not.toContain('claimWithRecipient');
    expect(out).not.toContain('setClaimRecipient');
    expect(out).not.toContain('toggleOperator');
  });

  it('rendering throws when the merkl alias namespace is absent', () => {
    const bare = makeConfigEnv({ searchPaths: [TEMPLATES_DIR], aliases: {} });
    expect(() => bare.render('merkl/merkl.tmpl', {})).toThrow();
  });
});
