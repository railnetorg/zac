import * as viemChains from 'viem/chains';
import { ZacError } from '../errors';
import {
  isKnownNetworkDirectory,
  networkForDirectory,
  supportedNetworkDirectories,
} from './networkTable';

/** Checks whether a chain id is registered in viem/chains. Exported for testing. */
export function chainIdInViem(id: number): boolean {
  for (const v of Object.values(viemChains)) {
    if (v && typeof v === 'object' && 'id' in v && (v as { id: unknown }).id === id) {
      return true;
    }
  }
  return false;
}

export interface NetworkCheckOpts {
  directoryName: string;
  declaredChainId: number;
}

export function checkNetwork(opts: NetworkCheckOpts): void {
  // (a) directory ↔ table
  if (!isKnownNetworkDirectory(opts.directoryName)) {
    throw new ZacError({
      phase: 'validate',
      message: `unknown network directory '${opts.directoryName}'; supported: [${supportedNetworkDirectories().join(', ')}]`,
    });
  }
  const expectedChainId = networkForDirectory(opts.directoryName);
  if (expectedChainId === null) {
    throw new ZacError({
      phase: 'validate',
      message: `internal: networkForDirectory returned null for '${opts.directoryName}'`,
    });
  }
  if (expectedChainId !== opts.declaredChainId) {
    throw new ZacError({
      phase: 'validate',
      message: `directory '${opts.directoryName}' implies chain_id ${expectedChainId} but config declares ${opts.declaredChainId}`,
    });
  }

  // (b) chain_id ↔ viem/chains
  if (!chainIdInViem(opts.declaredChainId)) {
    throw new ZacError({
      phase: 'validate',
      message: `chain_id ${opts.declaredChainId} is not in viem/chains`,
    });
  }
}
