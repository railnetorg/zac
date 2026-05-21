import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeRoleStates } from '../../emit/mergeRoleStates';
import { ZacError } from '../../errors';

const ADDR_A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ADDR_B = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const ADDR_A_LOWER = ADDR_A.toLowerCase();

let stderrSpy: ReturnType<typeof vi.spyOn>;
let written = '';
beforeEach(() => {
  written = '';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    written += typeof c === 'string' ? c : (c as Buffer).toString();
    return true;
  });
});
afterEach(() => stderrSpy.mockRestore());

describe('mergeRoleStates', () => {
  it('T8-1: same key + disjoint (address, signature) merges both', () => {
    const out = mergeRoleStates([
      {
        key: 'K',
        members: [],
        roles: [{ address: ADDR_A, functions: [{ signature: 'foo()' }] }],
      },
      {
        key: 'K',
        members: [],
        roles: [{ address: ADDR_B, functions: [{ signature: 'bar()' }] }],
      },
    ]);
    expect(out['K']!.roles.length).toBe(2);
  });

  it('T8-2: same key + same (address, signature) → ZacError', () => {
    expect(() =>
      mergeRoleStates([
        {
          key: 'K',
          members: [],
          roles: [{ address: ADDR_A, functions: [{ signature: 'foo()' }] }],
        },
        {
          key: 'K',
          members: [],
          roles: [{ address: ADDR_A, functions: [{ signature: 'foo()' }] }],
        },
      ]),
    ).toThrow(ZacError);
  });

  it('T8-3: members union dedup', () => {
    const out = mergeRoleStates([
      { key: 'K', members: [ADDR_A], roles: [] },
      { key: 'K', members: [ADDR_A, ADDR_B], roles: [] },
    ]);
    expect(out['K']!.members.sort()).toEqual([ADDR_A, ADDR_B].sort());
  });

  it('T8-4: duplicate member emits WARN', () => {
    mergeRoleStates([{ key: 'K', members: [ADDR_A, ADDR_A], roles: [] }]);
    expect(written).toContain("WARN: duplicate member '" + ADDR_A + "'");
  });

  it('T8-5: case-insensitive dedup via checksum', () => {
    const out = mergeRoleStates([{ key: 'K', members: [ADDR_A_LOWER, ADDR_A], roles: [] }]);
    expect(out['K']!.members.length).toBe(1);
    expect(out['K']!.members[0]).toBe(ADDR_A); // checksummed form
  });

  it('T8-6: different keys produce separate groups', () => {
    const out = mergeRoleStates([
      { key: 'K1', members: [ADDR_A], roles: [] },
      { key: 'K2', members: [ADDR_B], roles: [] },
    ]);
    expect(Object.keys(out).sort()).toEqual(['K1', 'K2']);
    expect(out['K1']!.members).toEqual([ADDR_A]);
    expect(out['K2']!.members).toEqual([ADDR_B]);
  });

  it('T8-7: empty entries produces empty merged state', () => {
    const out = mergeRoleStates([]);
    expect(out).toEqual({});
  });
});
