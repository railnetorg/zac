import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGenerated } from '../../apply/parseGenerated';
import { ZacError } from '../../errors';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zac-apply-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const VALID_YAML = `deployment:
  chain_id: 1
  safe_address: "0x3333333333333333333333333333333333333333"
  roles_modifier_address: "0x4444444444444444444444444444444444444444"
roles:
  AAVE_V3:
    members:
      - "0x1111111111111111111111111111111111111111"
    targets:
      - address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
        functions:
          - signature: "function approve(address spender, uint256 amount)"
            execution_options: none
            params:
              - name: spender
                operator: equal_to
                value: "0x0000000000000000000000000000000000000001"
                value_type: address
              - name: amount
                operator: pass
`;

function writeFixture(content: string): string {
  const d = makeTempDir();
  const p = join(d, 'gen.yaml');
  writeFileSync(p, content);
  return p;
}

describe('parseGenerated', () => {
  it('T11-1: parses a valid generated YAML round-trip', () => {
    const p = writeFixture(VALID_YAML);
    const out = parseGenerated(p);
    expect(out.deployment.chain_id).toBe(1);
    expect(out.deployment.safe_address).toBe('0x3333333333333333333333333333333333333333');
    expect(out.deployment.roles_modifier_address).toBe(
      '0x4444444444444444444444444444444444444444',
    );
    expect(out.roles['AAVE_V3']).toBeDefined();
    expect(out.roles['AAVE_V3']!.members).toEqual(['0x1111111111111111111111111111111111111111']);
    expect(out.roles['AAVE_V3']!.targets[0]!.address).toBe(
      '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    );
    expect(out.roles['AAVE_V3']!.targets[0]!.functions[0]!.signature).toContain('approve');
  });

  it('T11-4: missing deployment block → ZacError(phase=validate)', () => {
    const p = writeFixture(`roles:
  AAVE_V3:
    members: []
    targets: []
`);
    expect(() => parseGenerated(p)).toThrow(ZacError);
    try {
      parseGenerated(p);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('deployment');
    }
  });

  it('T11-5: invalid safe_address → ZacError(phase=validate)', () => {
    const p = writeFixture(`deployment:
  chain_id: 1
  safe_address: "not-an-address"
  roles_modifier_address: "0x4444444444444444444444444444444444444444"
roles: {}
`);
    expect(() => parseGenerated(p)).toThrow(ZacError);
    try {
      parseGenerated(p);
    } catch (e) {
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain('safe_address');
    }
  });

  it('T11-6: nonexistent file → ZacError(phase=load)', () => {
    expect(() => parseGenerated('/definitely/does/not/exist.yaml')).toThrow(ZacError);
    try {
      parseGenerated('/definitely/does/not/exist.yaml');
    } catch (e) {
      expect((e as ZacError).phase).toBe('load');
      expect((e as ZacError).message).toContain('failed to read');
    }
  });

  it('T11-6b: malformed YAML → ZacError(phase=parse)', () => {
    // Invalid YAML: unmatched bracket triggers eemeli/yaml parse error.
    const p = writeFixture('deployment: [unbalanced\n');
    expect(() => parseGenerated(p)).toThrow(ZacError);
    try {
      parseGenerated(p);
    } catch (e) {
      expect((e as ZacError).phase).toBe('parse');
      expect((e as ZacError).message).toContain('YAML parse failed');
    }
  });
});
