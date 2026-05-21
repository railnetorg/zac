import { z } from 'zod';
import { isAddress } from 'viem';

const AddressString = z.string().refine((s) => isAddress(s), {
  message: 'must be a valid Ethereum address',
});

const ChainIdSchema = z
  .number()
  .int({ message: 'chain_id must be an integer' })
  .positive({ message: 'chain_id must be positive' });

const ConfigEntrySchema = z.object({
  template: z.string().min(1),
  key: z.string().min(1),
  members: z.array(z.string().min(1)).default([]),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const DeploymentConfigSchema = z.object({
  chain_id: ChainIdSchema,
  roles_modifier_address: AddressString,
  safe_address: AddressString,
  name: z.string().min(1),
  description: z.string().default(''),
  configs: z.array(ConfigEntrySchema),
});

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;
