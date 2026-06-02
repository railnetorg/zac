import { describe, it, expect } from 'vitest';
import { PlanSchema, serializePlan, parsePlan, type Plan } from '../../apply/planSchema';

function makePlan(callsCount = 2): Plan {
  const calls = Array.from({ length: callsCount }, (_, i) => ({
    to: '0x4444444444444444444444444444444444444444',
    value: '0',
    data: ('0xdeadbeef' + i.toString(16)) as `0x${string}`,
  }));
  return {
    calls,
    callsCount: 999, // deliberately wrong; serializePlan must fix
    chainId: 1,
    modifierAddress: '0x4444444444444444444444444444444444444444',
    safeAddress: '0x3333333333333333333333333333333333333333',
  };
}

describe('planSchema', () => {
  it('TM-6a: serializePlan emits alphabetically-ordered keys at the top level', () => {
    const json = serializePlan(makePlan());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const topKeys = Object.keys(parsed);
    const expected = ['calls', 'callsCount', 'chainId', 'modifierAddress', 'safeAddress'];
    expect(topKeys).toEqual(expected);
  });

  it('TM-6c: serializePlan recomputes callsCount from calls.length', () => {
    const json = serializePlan(makePlan(3));
    const parsed = JSON.parse(json) as { callsCount: number; calls: unknown[] };
    expect(parsed.callsCount).toBe(3);
    expect(parsed.calls.length).toBe(3);
  });

  it('TM-6d: round-trip via JSON.parse + PlanSchema.parse preserves all fields', () => {
    const plan = makePlan(2);
    const json = serializePlan(plan);
    const reparsed = parsePlan(json);
    expect(reparsed.chainId).toBe(plan.chainId);
    expect(reparsed.safeAddress).toBe(plan.safeAddress);
    expect(reparsed.modifierAddress).toBe(plan.modifierAddress);
    expect(reparsed.callsCount).toBe(2);
    expect(reparsed.calls.length).toBe(2);
  });

  it('TM-6e: PlanSchema rejects malformed input (missing callsCount)', () => {
    const bad = JSON.parse(serializePlan(makePlan())) as Record<string, unknown>;
    delete bad['callsCount'];
    expect(() => PlanSchema.parse(bad)).toThrow();
  });
});
