import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import { serializeRoleStates } from '../../emit/serialize';
import type { MergedRoleState } from '../../emit/mergeRoleStates';

const ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const sample: MergedRoleState = {
  AAVE_V3: {
    members: [ADDR],
    roles: [
      {
        address: ADDR,
        functions: [{ signature: 'approve(address spender, uint256 amount)' }],
      },
    ],
  },
};

const stubDeployment = {
  chain_id: 1,
  safe_address: '0x3333333333333333333333333333333333333333',
  roles_modifier_address: '0x4444444444444444444444444444444444444444',
};

interface ParsedRoleState {
  deployment: {
    chain_id: number;
    safe_address: string;
    roles_modifier_address: string;
  };
  roles: {
    AAVE_V3: {
      members: string[];
      targets: Array<{
        address: string;
        functions: Array<{ signature: string }>;
      }>;
    };
  };
}

describe('serialize', () => {
  it('T8-8: known input produces stable output', () => {
    const out = serializeRoleStates(sample, stubDeployment);
    expect(out).toContain('AAVE_V3:');
    expect(out).toContain('members:');
    expect(out).toContain(ADDR);
    expect(out).toContain('approve(address spender, uint256 amount)');
  });

  it('T8-9: addresses in output are checksummed', () => {
    const out = serializeRoleStates(sample, stubDeployment);
    // Mixed-case checksum check — the output address must match the input's case exactly.
    expect(out).toContain(ADDR);
    expect(out).not.toContain(ADDR.toLowerCase());
  });

  it('T8-10: round-trip parse equals input shape', () => {
    const out = serializeRoleStates(sample, stubDeployment);
    const doc = parseDocument(out);
    const json = doc.toJSON() as ParsedRoleState;
    expect(json.roles.AAVE_V3.members).toEqual([ADDR]);
    expect(json.roles.AAVE_V3.targets[0]!.address).toBe(ADDR);
    expect(json.roles.AAVE_V3.targets[0]!.functions[0]!.signature).toBe(
      'approve(address spender, uint256 amount)',
    );
  });

  it('T11-2: output starts with deployment: block before roles:', () => {
    const out = serializeRoleStates(sample, stubDeployment);
    const deploymentIdx = out.indexOf('deployment:');
    const rolesIdx = out.indexOf('roles:');
    expect(deploymentIdx).toBe(0);
    expect(rolesIdx).toBeGreaterThan(deploymentIdx);
  });

  it('T11-3: deployment block contains chain_id, safe_address, roles_modifier_address', () => {
    const out = serializeRoleStates(sample, stubDeployment);
    const doc = parseDocument(out);
    const json = doc.toJSON() as ParsedRoleState;
    expect(json.deployment.chain_id).toBe(1);
    expect(json.deployment.safe_address).toBe(stubDeployment.safe_address);
    expect(json.deployment.roles_modifier_address).toBe(stubDeployment.roles_modifier_address);
  });
});
