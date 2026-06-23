import { describe, expect, it } from 'vitest';
import nunjucks from 'nunjucks';
import { abiEncode } from '../../render/abiEncodeFilter';

// The Milkman price-checker innerData decoded from the proven mainnet swap
// (tx 0x8fc655…e69e6): abi.encode([USDC/USD, PYUSD/USD], [false, true]).
const PYUSD_INNER_DATA =
  '0x' +
  '0000000000000000000000000000000000000000000000000000000000000040' +
  '00000000000000000000000000000000000000000000000000000000000000a0' +
  '0000000000000000000000000000000000000000000000000000000000000002' +
  '0000000000000000000000008fffffd4afb6115b954bd326cbe7b4ba576818f6' +
  '00000000000000000000000039e31761911b9aabaef5fb81b18fd1c24a60e884' +
  '0000000000000000000000000000000000000000000000000000000000000002' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '0000000000000000000000000000000000000000000000000000000000000001';

describe('abiEncodeFilter', () => {
  it('encodes (address[] feeds, bool[] reverses) to the known on-chain innerData', () => {
    const feeds = [
      '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
      '0x39E31761911b9aaBAEF5fb81B18Fd1C24a60E884',
    ];
    const reverses = [false, true];
    expect(abiEncode([feeds, reverses], ['address[]', 'bool[]'])).toBe(PYUSD_INNER_DATA);
  });

  it('encodes a single scalar', () => {
    expect(abiEncode([200], ['uint256'])).toBe(
      '0x00000000000000000000000000000000000000000000000000000000000000c8',
    );
  });

  it('throws when value/type counts differ', () => {
    expect(() => abiEncode([1], ['uint256', 'bool'])).toThrow(/expected 2 value/);
  });

  it('throws when types is not an array of strings', () => {
    expect(() => abiEncode([1], 'uint256')).toThrow(/types.*array/);
  });

  it('surfaces an invalid address rather than producing garbage', () => {
    expect(() => abiEncode([['0xnotanaddress']], ['address[]'])).toThrow();
  });

  it('is callable from Nunjucks with array-literal arguments', () => {
    const env = new nunjucks.Environment(undefined, { throwOnUndefined: true });
    env.addFilter('abi_encode', abiEncode);
    const out = env
      .renderString("{{ [[a], [r]] | abi_encode(['address[]', 'bool[]']) }}", {
        a: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
        r: true,
      })
      .trim();
    expect(out).toMatch(/^0x[0-9a-f]+$/);
  });
});
