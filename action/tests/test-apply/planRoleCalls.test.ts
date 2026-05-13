import { describe, it, expect } from 'vitest';
import { planRoleCalls, type PlanApplyRoleFn } from '../../apply/planRoleCalls';
import type { Generated } from '../../apply/parseGenerated';
import { ZacError } from '../../errors';

const FIXED_KEY: `0x${string}` = `0x${'a'.repeat(64)}`;

const fakeEncodeKey = (_key: string): `0x${string}` => FIXED_KEY;

const generated: Generated = {
  deployment: {
    chain_id: 1,
    safe_address: '0x3333333333333333333333333333333333333333',
    roles_modifier_address: '0x4444444444444444444444444444444444444444',
  },
  roles: {
    AAVE_V3: {
      members: ['0x1111111111111111111111111111111111111111'],
      targets: [
        {
          address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
          functions: [{ signature: 'approve(address,uint256)' }],
        },
      ],
    },
    SECOND: {
      members: [],
      targets: [],
    },
  },
};

describe('planRoleCalls', () => {
  it('T11-9: calls injected planApplyRole once per role and aggregates results', async () => {
    const recorded: Array<{ key: string; chainId: number; address: string }> = [];
    const stub: PlanApplyRoleFn = async (desired, meta) => {
      recorded.push({ key: desired.key, chainId: meta.chainId, address: meta.address });
      return [
        {
          to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
          data: ('0x' + recorded.length.toString().padStart(8, '0')) as `0x${string}`,
        },
      ];
    };
    const out = await planRoleCalls({
      generated,
      planApplyRole: stub,
      encodeKey: fakeEncodeKey,
    });
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.chainId).toBe(1);
    expect(recorded[0]!.address).toBe('0x4444444444444444444444444444444444444444');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      to: '0x4444444444444444444444444444444444444444',
      value: '0',
      data: '0x00000001',
    });
    expect(out[1]!.value).toBe('0');
  });

  it('T11-10: empty SDK result → empty aggregated calls', async () => {
    const stub: PlanApplyRoleFn = async () => [];
    const out = await planRoleCalls({
      generated,
      planApplyRole: stub,
      encodeKey: fakeEncodeKey,
    });
    expect(out).toEqual([]);
  });

  it('T11-10b: planApplyRole throwing → ZacError(phase=apply) with chainId + modifier + roleKey in message', async () => {
    const stub: PlanApplyRoleFn = async () => {
      throw new Error('subgraph 503');
    };
    try {
      await planRoleCalls({
        generated,
        planApplyRole: stub,
        encodeKey: fakeEncodeKey,
      });
      throw new Error('expected planRoleCalls to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      const ze = e as ZacError;
      expect(ze.phase).toBe('apply');
      expect(ze.message).toContain('chainId=1');
      expect(ze.message).toContain('0x4444444444444444444444444444444444444444');
      expect(ze.message).toContain('roleKey=AAVE_V3');
      expect(ze.message).toContain('subgraph 503');
    }
  });
});
