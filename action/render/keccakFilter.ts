import { keccak256, toBytes } from 'viem';

/** Nunjucks filter: keccak256 of the UTF-8 bytes of the input string. */
export function keccak(s: string): string {
  return keccak256(toBytes(s));
}
