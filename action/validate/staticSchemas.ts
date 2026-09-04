import { z } from 'zod';
import { isAddress } from 'viem';

const AddressString = z.string().refine((s) => isAddress(s), {
  message: 'must be a valid Ethereum address',
});

const ChainIdSchema = z
  .number()
  .int({ message: 'chain_id must be an integer' })
  .positive({ message: 'chain_id must be positive' });

/**
 * One `configs[]` entry of a deployment config.
 *
 * Strict, because both defaulted keys fail silently when misspelled and both
 * failures are operational. `member:` leaves the role with no members at all,
 * and `--revoke-unmentioned` reads that as an instruction to revoke the
 * members it has on chain. `param:` leaves the template with no params, which
 * a template that requires one catches (`throwOnUndefined`) and a template
 * with only optional params does not — it renders a default policy instead.
 */
const ConfigEntrySchema = z
  .object({
    template: z.string().min(1),
    key: z.string().min(1),
    members: z.array(z.string().min(1)).default([]),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * A deployment config source (`<network>/<safe>/<name>.zac.yaml`), rendered.
 *
 * Strict for the same reason as the entries above: this is a hand-written
 * file, and a key ZAC does not read is a setting the author believes is in
 * force. Note that this closes the config's own vocabulary, not a template's
 * — an entry's `params` is a free-form record by construction, since only the
 * template it names knows which keys it reads.
 */
export const DeploymentConfigSchema = z
  .object({
    chain_id: ChainIdSchema,
    roles_modifier_address: AddressString,
    safe_address: AddressString,
    name: z.string().min(1),
    description: z.string().default(''),
    configs: z.array(ConfigEntrySchema),
  })
  .strict();

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;
