import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { isAddress, getAddress, keccak256, encodeAbiParameters } from 'viem';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const AAVE = resolve(REPO_ROOT, 'aliases/mainnet/aave.yaml');
const TOKENS = resolve(REPO_ROOT, 'aliases/mainnet/tokens.yaml');
const MORPHO_BLUE = resolve(REPO_ROOT, 'aliases/mainnet/morpho_blue.yaml');

type MorphoMarket = {
  loan_token: string;
  collateral_token: string;
  oracle: string;
  irm: string;
  lltv: string;
};

const morphoMarkets = (): Record<string, MorphoMarket> =>
  (
    parseDocument(readFileSync(MORPHO_BLUE, 'utf8')).toJSON() as {
      markets: Record<string, MorphoMarket>;
    }
  ).markets;

/** Morpho's market id: keccak256 over the MarketParams tuple, which is all-static. */
const marketId = (m: MorphoMarket): string =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        m.loan_token as `0x${string}`,
        m.collateral_token as `0x${string}`,
        m.oracle as `0x${string}`,
        m.irm as `0x${string}`,
        BigInt(m.lltv),
      ],
    ),
  );

describe('curated aliases', () => {
  it('T9-4: aave.pool is a valid checksummed address', () => {
    const doc = parseDocument(readFileSync(AAVE, 'utf8')).toJSON() as { pool: string };
    expect(isAddress(doc.pool)).toBe(true);
    expect(getAddress(doc.pool)).toBe(doc.pool);
  });

  it('T9-5: every token address is valid + checksummed', () => {
    const doc = parseDocument(readFileSync(TOKENS, 'utf8')).toJSON() as Record<string, string>;
    for (const [k, v] of Object.entries(doc)) {
      expect(isAddress(v)).toBe(true);
      expect(getAddress(v)).toBe(v);
      void k;
    }
  });

  // The template resolves these five fields with no existence guard and feeds
  // them straight into `matches` scoping, so a malformed address here does not
  // fail loudly — it scopes a market that does not exist.
  it('T9-6: every morpho_blue market field is a valid + checksummed address', () => {
    const markets = morphoMarkets();
    expect(Object.keys(markets).length).toBeGreaterThan(0);
    for (const [key, m] of Object.entries(markets)) {
      for (const field of ['loan_token', 'collateral_token', 'oracle', 'irm'] as const) {
        const v = m[field];
        expect(isAddress(v), `${key}.${field}`).toBe(true);
        expect(getAddress(v), `${key}.${field}`).toBe(v);
      }
      expect(BigInt(m.lltv), `${key}.lltv`).toBeGreaterThan(0n);
    }
  });

  // A wrong-but-well-formed address passes T9-6 and still scopes the wrong
  // market. Pinning the derived id is the only check that catches that, so any
  // market whose id is documented in the registry gets asserted here.
  it('T9-7: weth_wsteth_965 derives the documented Morpho market id', () => {
    const market = morphoMarkets().weth_wsteth_965;
    expect(market, 'weth_wsteth_965 missing from morpho_blue.yaml').toBeDefined();
    expect(marketId(market!)).toBe(
      '0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e',
    );
  });
});
