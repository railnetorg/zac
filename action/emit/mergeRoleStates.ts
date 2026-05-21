import { getAddress } from 'viem';
import { ZacError } from '../errors';
import { warn } from '../warn';

export interface FunctionRule {
  signature: string;
  execution_options?: string;
  params?: Array<Record<string, unknown> & { name: string }>;
}

export interface RoleAddressEntry {
  address: string;
  functions: FunctionRule[];
}

export interface ConfigEntry {
  key: string;
  members: string[]; // raw addresses or labels
  roles: RoleAddressEntry[]; // raw entries (one per address) from the rendered template
}

export interface MergedRoleStateGroup {
  members: string[]; // checksummed, deduped
  roles: RoleAddressEntry[]; // address checksummed, no (address,signature) duplicates
}

export interface MergedRoleState {
  /** key -> merged role state */
  [key: string]: MergedRoleStateGroup;
}

export function mergeRoleStates(entries: ConfigEntry[]): MergedRoleState {
  const out: MergedRoleState = {};

  for (const entry of entries) {
    const group: MergedRoleStateGroup = (out[entry.key] ??= { members: [], roles: [] });

    // Members: checksum + dedup
    const seenMembers = new Set(group.members);
    for (const m of entry.members) {
      // If it looks like a hex address, checksum it; otherwise keep as-is (label).
      const normalized = isHexAddress(m) ? getAddress(m) : m;
      if (seenMembers.has(normalized)) {
        warn(`duplicate member '${normalized}' in role '${entry.key}' — keeping first occurrence`);
        continue;
      }
      seenMembers.add(normalized);
      group.members.push(normalized);
    }

    // Roles: per-(address, signature) dedup with hard error on conflict
    for (const role of entry.roles) {
      const checksumAddr = getAddress(role.address);
      const existing = group.roles.find((r) => r.address === checksumAddr);
      if (!existing) {
        group.roles.push({ address: checksumAddr, functions: [...role.functions] });
        continue;
      }
      for (const fn of role.functions) {
        const dup = existing.functions.find((f) => f.signature === fn.signature);
        if (dup) {
          throw new ZacError({
            phase: 'emit',
            message: `duplicate (address=${checksumAddr}, signature='${fn.signature}') in role key '${entry.key}'`,
          });
        }
        existing.functions.push(fn);
      }
    }
  }

  return out;
}

function isHexAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}
