import { describe, it, expect } from 'vitest';
import { groupPlansBySafe } from '../../discover';
import type { Plan } from '../../apply/planSchema';

function makePlan(overrides: Partial<Plan> & Pick<Plan, 'safeAddress' | 'chainId'>): Plan {
  const base: Plan = {
    calls: [
      {
        to: '0x4444444444444444444444444444444444444444',
        value: '0',
        data: '0xdeadbeef',
      },
    ],
    callsCount: 1,
    chainId: 1,
    modifierAddress: '0x4444444444444444444444444444444444444444',
    safeAddress: '0x0000000000000000000000000000000000000000',
    safeTxData: {
      baseGas: '0',
      data: '0xdeadbeef',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      nonce: 0,
      operation: 0,
      refundReceiver: '0x0000000000000000000000000000000000000000',
      safeTxGas: '0',
      to: '0x4444444444444444444444444444444444444444',
      value: '0',
    },
    safeTxHash: '0xfeedbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef',
  };
  return { ...base, ...overrides };
}

const SAFE_A_LO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SAFE_A_CHK = '0xAAAAaaAAaaaAAAaaaAAAAaAaaaaAaaAAaaAAAAAA';
const SAFE_B_LO = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('groupPlansBySafe', () => {
  it('TB-1: empty input → empty array', () => {
    expect(groupPlansBySafe([])).toEqual([]);
  });

  it('TB-2: single plan → single group of one', () => {
    const plan = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const groups = groupPlansBySafe([plan]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.safeAddress).toBe(SAFE_A_LO);
    expect(groups[0]!.chainId).toBe(1);
    expect(groups[0]!.plans).toEqual([plan]);
  });

  it('TB-3: two plans, same (safeAddress, chainId) → one group of two', () => {
    const a = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const b = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const groups = groupPlansBySafe([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.plans).toEqual([a, b]);
  });

  it('TB-4: same safeAddress but different chainId → two groups', () => {
    const a = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const b = makePlan({ safeAddress: SAFE_A_LO, chainId: 137 });
    const groups = groupPlansBySafe([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.chainId).toBe(1);
    expect(groups[1]!.chainId).toBe(137);
  });

  it('TB-5: same chainId but different safeAddress → two groups', () => {
    const a = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const b = makePlan({ safeAddress: SAFE_B_LO, chainId: 1 });
    const groups = groupPlansBySafe([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.safeAddress).toBe(SAFE_A_LO);
    expect(groups[1]!.safeAddress).toBe(SAFE_B_LO);
  });

  it('TB-6: order is deterministic — groups appear in first-encounter order, plans preserve input order', () => {
    const a1 = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const b1 = makePlan({ safeAddress: SAFE_B_LO, chainId: 1 });
    const a2 = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const b2 = makePlan({ safeAddress: SAFE_B_LO, chainId: 1 });
    const groups = groupPlansBySafe([a1, b1, a2, b2]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.safeAddress).toBe(SAFE_A_LO);
    expect(groups[0]!.plans).toEqual([a1, a2]);
    expect(groups[1]!.safeAddress).toBe(SAFE_B_LO);
    expect(groups[1]!.plans).toEqual([b1, b2]);
  });

  it('TB-7: case-insensitive grouping — same safe spelled checksum vs lowercase → ONE group', () => {
    // The safe-dir convention lowercases dir names; legacy mode preserves
    // the YAML body's casing (typically EIP-55 checksum). Both must group
    // into the same Safe transaction.
    const a = makePlan({ safeAddress: SAFE_A_CHK, chainId: 1 });
    const b = makePlan({ safeAddress: SAFE_A_LO, chainId: 1 });
    const groups = groupPlansBySafe([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.plans).toEqual([a, b]);
    // The preserved safeAddress is from the first plan encountered.
    expect(groups[0]!.safeAddress).toBe(SAFE_A_CHK);
  });
});
