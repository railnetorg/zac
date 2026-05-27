import { describe, it, expect } from 'vitest';
import { renderParamTree, type TreeNode } from '../../apply/renderParamTree';
import type { FunctionParams, AbiInput } from '../../apply/buildFunctionParamMap';

/** Flatten a tree to a list of indented strings — useful for snapshot-style asserts. */
function flatten(nodes: TreeNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(`${'  '.repeat(depth)}${node.label}`);
    if (node.children) out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

function input(type: string, name: string, components?: AbiInput[]): AbiInput {
  if (components !== undefined) return { type, name, components };
  return { type, name };
}

function fn(
  signature: string,
  inputs: AbiInput[],
  params: Array<{ name: string; operator: string; [k: string]: unknown }>,
): FunctionParams {
  return { signature, fnName: signature.split('(')[0]!, inputs, params };
}

describe('renderParamTree', () => {
  it('all-leaf mix: oneOf inlines as `in (...)`, equal_to_avatar shows `= <avatar>`, pass shows bare `*`', () => {
    const tree = renderParamTree(
      fn(
        'supply',
        [
          input('address', 'asset'),
          input('uint256', 'amount'),
          input('address', 'onBehalfOf'),
          input('uint16', 'referralCode'),
        ],
        [
          {
            name: 'asset',
            operator: 'oneOf',
            values: [
              '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
              '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            ],
            value_type: 'address',
          },
          { name: 'amount', operator: 'pass' },
          { name: 'onBehalfOf', operator: 'equal_to_avatar' },
          { name: 'referralCode', operator: 'pass' },
        ],
      ),
      { '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'tokens.USDC' },
    );
    const flat = flatten(tree);
    expect(flat[0]).toMatch(/^address asset\s+in \(0xA0b8…eB48 \(tokens\.USDC\), 0xC02a…6Cc2\)/);
    expect(flat[1]).toMatch(/^uint256 amount\s+\*/);
    expect(flat[2]).toMatch(/^address onBehalfOf\s+= <avatar>/);
    expect(flat[3]).toMatch(/^uint16\s+referralCode\s+\*/);
  });

  it('`or` of two `equal_to` leaves collapses to inline `in (a, b)` (same as oneOf)', () => {
    const tree = renderParamTree(
      fn(
        'approve',
        [input('address', 'spender'), input('uint256', 'amount')],
        [
          {
            name: 'spender',
            operator: 'or',
            conditions: [
              {
                operator: 'equal_to',
                value: '0x1111111111111111111111111111111111111111',
                value_type: 'address',
              },
              {
                operator: 'equal_to',
                value: '0x2222222222222222222222222222222222222222',
                value_type: 'address',
              },
            ],
          },
          { name: 'amount', operator: 'pass' },
        ],
      ),
      undefined,
    );
    const flat = flatten(tree);
    expect(flat[0]).toMatch(/in \(0x1111…1111, 0x2222…2222\)/);
    expect(flat[1]).toMatch(/\*$/);
  });

  it('`matches` on a tuple expands children with the tuple field names', () => {
    const tree = renderParamTree(
      fn(
        'supply',
        [
          input('tuple', 'marketParams', [input('address', 'loanToken'), input('uint256', 'lltv')]),
          input('uint256', 'assets'),
        ],
        [
          {
            name: 'marketParams',
            operator: 'matches',
            conditions: [
              {
                operator: 'equal_to',
                value: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                value_type: 'address',
              },
              { operator: 'equal_to', value: '860000000000000000', value_type: 'uint256' },
            ],
          },
          { name: 'assets', operator: 'pass' },
        ],
      ),
      { '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'tokens.USDC' },
    );
    expect(tree[0]?.label).toMatch(/^tuple\s+marketParams\s+= matches/);
    expect(tree[0]?.children).toHaveLength(2);
    expect(tree[0]?.children?.[0]?.label).toMatch(
      /^address loanToken\s+= 0xA0b8…eB48 \(tokens\.USDC\)/,
    );
    expect(tree[0]?.children?.[1]?.label).toMatch(/^uint256 lltv\s+= 860000000000000000/);
    expect(tree[1]?.label).toMatch(/^uint256 assets\s+\*/);
  });

  it('`or` of `matches` (Morpho-Blue tuple-or pattern) expands into numbered `option N` children', () => {
    const tree = renderParamTree(
      fn(
        'supply',
        [
          input('tuple', 'marketParams', [
            input('address', 'loanToken'),
            input('address', 'collateralToken'),
          ]),
        ],
        [
          {
            name: 'marketParams',
            operator: 'or',
            conditions: [
              {
                operator: 'matches',
                conditions: [
                  { operator: 'equal_to', value: '0xaaaa', value_type: 'address' },
                  { operator: 'equal_to', value: '0xbbbb', value_type: 'address' },
                ],
              },
              {
                operator: 'matches',
                conditions: [
                  { operator: 'equal_to', value: '0xaaaa', value_type: 'address' },
                  { operator: 'equal_to', value: '0xcccc', value_type: 'address' },
                ],
              },
            ],
          },
        ],
      ),
      undefined,
    );
    expect(tree[0]?.label).toMatch(/^tuple\s+marketParams\s+= oneOf/);
    expect(tree[0]?.children?.map((c) => c.label)).toEqual(['option 1', 'option 2']);
    // Option-1's children carry the tuple field constraints.
    expect(tree[0]?.children?.[0]?.children?.[0]?.label).toMatch(/loanToken\s+= 0xaaaa/);
    expect(tree[0]?.children?.[0]?.children?.[1]?.label).toMatch(/collateralToken\s+= 0xbbbb/);
    expect(tree[0]?.children?.[1]?.children?.[1]?.label).toMatch(/collateralToken\s+= 0xcccc/);
  });

  it('comparison operators render `>` / `<` / signed variants', () => {
    const tree = renderParamTree(
      fn(
        'f',
        [input('uint256', 'a'), input('uint256', 'b'), input('int256', 'c')],
        [
          { name: 'a', operator: 'greater_than', value: 100, value_type: 'uint256' },
          { name: 'b', operator: 'less_than', value: 50, value_type: 'uint256' },
          { name: 'c', operator: 'signed_int_greater_than', value: -1, value_type: 'int256' },
        ],
      ),
      undefined,
    );
    const flat = flatten(tree);
    expect(flat[0]).toMatch(/uint256 a\s+> 100/);
    expect(flat[1]).toMatch(/uint256 b\s+< 50/);
    expect(flat[2]).toMatch(/int256\s+c\s+> -1/);
  });

  it('input present in signature but missing from source params renders as bare `*` (apply reads it as pass)', () => {
    const tree = renderParamTree(
      fn(
        'f',
        [input('uint256', 'declared'), input('uint256', 'missing')],
        [{ name: 'declared', operator: 'equal_to', value: 7, value_type: 'uint256' }],
      ),
      undefined,
    );
    const flat = flatten(tree);
    expect(flat[0]).toMatch(/declared\s+= 7/);
    expect(flat[1]).toMatch(/missing\s+\*/);
  });

  it('boolean equal_to renders `true` / `false` rather than `1` / `0`', () => {
    const tree = renderParamTree(
      fn(
        'f',
        [input('bool', 'flag')],
        [{ name: 'flag', operator: 'equal_to', value: true, value_type: 'bool' }],
      ),
      undefined,
    );
    expect(tree[0]?.label).toMatch(/flag\s+= true/);
  });

  it('returns empty array when the function has no inputs', () => {
    const tree = renderParamTree(fn('f', [], []), undefined);
    expect(tree).toEqual([]);
  });
});
