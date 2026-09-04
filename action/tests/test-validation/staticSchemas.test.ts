import { describe, expect, it } from 'vitest';
import { DeploymentConfigSchema } from '../../validate/staticSchemas';

const SAFE_ADDR = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const MOD_ADDR = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

const valid = {
  chain_id: 1,
  roles_modifier_address: MOD_ADDR,
  safe_address: SAFE_ADDR,
  name: 'My Safe',
  description: 'desc',
  configs: [],
};

describe('staticSchemas', () => {
  it('T6-1: minimal valid config parses', () => {
    expect(DeploymentConfigSchema.safeParse(valid).success).toBe(true);
  });

  it('T6-2: missing chain_id rejected', () => {
    const { chain_id: _chainId, ...rest } = valid;
    void _chainId;
    expect(DeploymentConfigSchema.safeParse(rest).success).toBe(false);
  });

  it('T6-3: chain_id not a number rejected', () => {
    expect(DeploymentConfigSchema.safeParse({ ...valid, chain_id: 'one' }).success).toBe(false);
  });

  it('T6-3a: chain_id negative rejected', () => {
    expect(DeploymentConfigSchema.safeParse({ ...valid, chain_id: -1 }).success).toBe(false);
  });

  it('T6-3b: chain_id float rejected', () => {
    expect(DeploymentConfigSchema.safeParse({ ...valid, chain_id: 1.5 }).success).toBe(false);
  });

  it('T6-4: roles_modifier_address invalid rejected', () => {
    expect(
      DeploymentConfigSchema.safeParse({ ...valid, roles_modifier_address: 'notahex' }).success,
    ).toBe(false);
  });

  it('T6-5: safe_address invalid rejected', () => {
    expect(DeploymentConfigSchema.safeParse({ ...valid, safe_address: 'bad' }).success).toBe(false);
  });

  it('T6-6: empty configs array accepted', () => {
    expect(DeploymentConfigSchema.safeParse({ ...valid, configs: [] }).success).toBe(true);
  });

  it('T6-7: configs[].key missing rejected', () => {
    expect(
      DeploymentConfigSchema.safeParse({
        ...valid,
        configs: [{ template: 't.tmpl', members: [], params: {} }],
      }).success,
    ).toBe(false);
  });

  it('T6-8: a stray key at the top level is rejected, and the message names it', () => {
    const result = DeploymentConfigSchema.safeParse({ ...valid, valuation_manager: MOD_ADDR });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('valuation_manager');
  });

  it('T6-9: a stray key in a configs[] entry is rejected', () => {
    expect(
      DeploymentConfigSchema.safeParse({
        ...valid,
        configs: [{ template: 't.tmpl', key: 'K', members: [], params: {}, stray_key: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('T6-10: `member:` is rejected rather than defaulted to an empty member list', () => {
    // The failure this closes: both `members` and `params` are defaulted, so a
    // misspelling of either parses. `member:` yields a role with no members at
    // all, and `--revoke-unmentioned` reads that as an instruction to revoke
    // the members the role has on chain.
    const withTypo = DeploymentConfigSchema.safeParse({
      ...valid,
      configs: [{ template: 't.tmpl', key: 'K', member: [SAFE_ADDR], params: {} }],
    });
    expect(withTypo.success).toBe(false);
    expect(withTypo.error?.issues[0]?.message).toContain('member');
  });

  it('T6-11: `params` itself stays free-form — only the template knows its keys', () => {
    expect(
      DeploymentConfigSchema.safeParse({
        ...valid,
        configs: [{ template: 't.tmpl', key: 'K', params: { borrow: true, markets: ['a'] } }],
      }).success,
    ).toBe(true);
  });
});
