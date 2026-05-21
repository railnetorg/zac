import { describe, it, expect } from 'vitest';
import { planSafeDirCalls, type PlanApplyFn, type SdkRole } from '../../apply/planSafeDirCalls';
import type { Generated } from '../../apply/parseGenerated';
import { ZacError } from '../../errors';

const FIXED_KEY: `0x${string}` = `0x${'a'.repeat(64)}`;
const fakeEncodeKey = (_key: string): `0x${string}` => FIXED_KEY;

function makeGenerated(overrides: {
  chainId?: number;
  safeAddress?: string;
  modifierAddress?: string;
  roles: Record<string, { members: string[]; targets: unknown[] }>;
}): Generated {
  return {
    deployment: {
      chain_id: overrides.chainId ?? 1,
      safe_address: overrides.safeAddress ?? '0x3333333333333333333333333333333333333333',
      roles_modifier_address:
        overrides.modifierAddress ?? '0x4444444444444444444444444444444444444444',
    },
    roles: Object.fromEntries(
      Object.entries(overrides.roles).map(([k, v]) => [
        k,
        {
          members: v.members,
          targets: v.targets as Generated['roles'][string]['targets'],
        },
      ]),
    ),
  };
}

describe('planSafeDirCalls', () => {
  it('TS-1: aggregates roles across multiple generateds and calls planApply once with the union', async () => {
    let captured: { roles: SdkRole[]; meta: { chainId: number; address: string } } | null = null;
    const stub: PlanApplyFn = async (desired, meta) => {
      captured = { roles: desired.roles, meta };
      return [
        {
          to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
          data: '0xdeadbeef' as `0x${string}`,
        },
      ];
    };
    const a = makeGenerated({
      roles: { ALPHA: { members: ['0x1111111111111111111111111111111111111111'], targets: [] } },
    });
    const b = makeGenerated({
      roles: { BRAVO: { members: ['0x2222222222222222222222222222222222222222'], targets: [] } },
    });
    const calls = await planSafeDirCalls({
      generateds: [a, b],
      planApply: stub,
      encodeKey: fakeEncodeKey,
    });
    expect(captured).not.toBeNull();
    expect(captured!.roles).toHaveLength(2);
    expect(captured!.meta.chainId).toBe(1);
    expect(captured!.meta.address).toBe('0x4444444444444444444444444444444444444444');
    expect(calls).toEqual([
      { to: '0x4444444444444444444444444444444444444444', value: '0', data: '0xdeadbeef' },
    ]);
  });

  it('TS-2: role ordering is alphabetical by role key', async () => {
    let captured: SdkRole[] | null = null;
    const stub: PlanApplyFn = async (desired) => {
      captured = desired.roles;
      return [];
    };
    // Inputs intentionally NOT alphabetical: ZULU, ALPHA, MIKE.
    const z = makeGenerated({ roles: { ZULU: { members: [], targets: [] } } });
    const a = makeGenerated({ roles: { ALPHA: { members: [], targets: [] } } });
    const m = makeGenerated({ roles: { MIKE: { members: [], targets: [] } } });
    // planSafeDirCalls throws on 0 calls path? No — that's runPlanForSafeDir.
    // planSafeDirCalls returns [] on empty SDK result.
    await planSafeDirCalls({
      generateds: [z, a, m],
      planApply: stub,
      encodeKey: (k: string) => `0x${k.padEnd(64, '0')}` as `0x${string}`,
    });
    expect(captured).not.toBeNull();
    // After alphabetical sort: ALPHA, MIKE, ZULU. The encoded keys reflect
    // the role-key string so we can read them back.
    expect(captured!).toHaveLength(3);
    expect(captured![0]!.key).toMatch(/^0xALPHA/);
    expect(captured![1]!.key).toMatch(/^0xMIKE/);
    expect(captured![2]!.key).toMatch(/^0xZULU/);
  });

  it('TS-3: revoke calls in SDK output flow through to caller (no filtering)', async () => {
    // Simulate the SDK returning a mix of grant + revoke calls. The
    // primitive does NOT inspect call payloads — it just wraps them as
    // Call[] with `value: "0"`. The "revoke unmentioned" semantic is the
    // SDK's job; we assert the wiring.
    const stub: PlanApplyFn = async () => [
      {
        to: '0xModifier000000000000000000000000000000000' as `0x${string}`,
        data: '0xAAAAAAAA' as `0x${string}`,
      },
      // Imagine this is the SDK-emitted revoke for a role on the modifier
      // not present in `desired.roles`.
      {
        to: '0xModifier000000000000000000000000000000000' as `0x${string}`,
        data: '0xBBBBBBBB' as `0x${string}`,
      },
    ];
    const g = makeGenerated({
      roles: { ROLE_A: { members: [], targets: [] } },
    });
    const calls = await planSafeDirCalls({
      generateds: [g],
      planApply: stub,
      encodeKey: fakeEncodeKey,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.value).toBe('0');
    expect(calls[1]!.value).toBe('0');
    expect(calls[0]!.data).toBe('0xAAAAAAAA');
    expect(calls[1]!.data).toBe('0xBBBBBBBB');
  });

  it('TS-4: planApply throwing → ZacError(phase=apply) with chainId + modifier in message', async () => {
    const stub: PlanApplyFn = async () => {
      throw new Error('subgraph 503');
    };
    const g = makeGenerated({
      chainId: 8453,
      modifierAddress: '0xd6ab940C6417326EAD37A0DC46ec53A4ac34005B',
      roles: { ROLE_A: { members: [], targets: [] } },
    });
    try {
      await planSafeDirCalls({
        generateds: [g],
        planApply: stub,
        encodeKey: fakeEncodeKey,
      });
      throw new Error('expected planSafeDirCalls to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      const ze = e as ZacError;
      expect(ze.phase).toBe('apply');
      expect(ze.message).toContain('chainId=8453');
      expect(ze.message).toContain('0xd6ab940C6417326EAD37A0DC46ec53A4ac34005B');
      expect(ze.message).toContain('subgraph 503');
    }
  });

  it('TS-5: duplicate role key across sources → ZacError(phase=validate)', async () => {
    const stub: PlanApplyFn = async () => [];
    const a = makeGenerated({ roles: { ROLE: { members: [], targets: [] } } });
    const b = makeGenerated({ roles: { ROLE: { members: [], targets: [] } } });
    try {
      await planSafeDirCalls({
        generateds: [a, b],
        planApply: stub,
        encodeKey: fakeEncodeKey,
      });
      throw new Error('expected planSafeDirCalls to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ZacError);
      expect((e as ZacError).phase).toBe('validate');
      expect((e as ZacError).message).toContain("duplicate role key 'ROLE'");
    }
  });

  it('TS-6: empty SDK result → empty Call[]', async () => {
    const stub: PlanApplyFn = async () => [];
    const g = makeGenerated({ roles: { ROLE_A: { members: [], targets: [] } } });
    const calls = await planSafeDirCalls({
      generateds: [g],
      planApply: stub,
      encodeKey: fakeEncodeKey,
    });
    expect(calls).toEqual([]);
  });
});
