import { stringify } from 'yaml';
import type { MergedRoleState } from './mergeRoleStates';

export interface DeploymentMeta {
  chain_id: number;
  safe_address: string;
  roles_modifier_address: string;
}

export function serializeRoleStates(state: MergedRoleState, deployment: DeploymentMeta): string {
  // Convert to a stable shape:
  //   { deployment: { ... }, roles: { <key>: { members, targets } } }
  const out = {
    deployment,
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
