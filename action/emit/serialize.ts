import { stringify } from 'yaml';
import type { MergedRoleState } from './mergeRoleStates';

export function serializeRoleStates(state: MergedRoleState): string {
  // Convert to a stable shape: { roles: { <key>: { members, targets } } }
  const out = {
    roles: Object.fromEntries(
      Object.entries(state).map(([key, val]) => [
        key,
        {
          members: val.members,
          targets: val.roles.map((r) => ({
            address: r.address,
            functions: r.functions,
          })),
        },
      ]),
    ),
  };
  return stringify(out, { lineWidth: 0 }); // lineWidth: 0 disables auto-wrapping
}
