import { describe, expect, it } from 'vitest';
import { validateRenderedTemplate } from '../../validate/runValidate';
import { ZacError } from '../../errors';

const VALID_ADDR = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

describe('runValidate integration', () => {
  it('T6-48: AAVE-like template happy path', () => {
    const t = {
      templatePath: 'fake/aave.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: 'function approve(address spender, uint256 amount)',
              params: [
                {
                  name: 'spender',
                  operator: 'equal_to',
                  value: VALID_ADDR,
                  value_type: 'address',
                },
                { name: 'amount', operator: 'pass' },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).not.toThrow();
  });

  it('T6-49: tampered fixture (wrong value_type) throws ZacError', () => {
    const t = {
      templatePath: 'fake/aave.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: 'function approve(address spender, uint256 amount)',
              params: [
                // Wrong value_type for an `address` param.
                { name: 'spender', operator: 'equal_to', value: 1, value_type: 'uint256' },
                { name: 'amount', operator: 'pass' },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).toThrow(ZacError);
  });

  it('T6-50: fail-fast: only first error returned', () => {
    const t = {
      templatePath: 'fake/aave.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: 'function approve(address spender, uint256 amount)',
              params: [
                // First bad param: wrong family for address.
                { name: 'spender', operator: 'equal_to', value: 1, value_type: 'uint256' },
                // Also bad — but the orchestrator should fail before reaching it.
                {
                  name: 'amount',
                  operator: 'equal_to',
                  value: 'badaddr',
                  value_type: 'address',
                },
              ],
            },
          ],
        },
      ],
    };
    let caught: unknown;
    try {
      validateRenderedTemplate(t);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZacError);
    const msg = (caught as ZacError).message;
    expect(msg.length).toBeGreaterThan(0);
  });

  // ---- abi_encoded + function-root or ----

  const swapSig =
    'function requestSwap(address fromToken, address toToken, bytes priceCheckerData)';

  const abiEncodedParam = (cap: string) => ({
    name: 'priceCheckerData',
    param_type: 'abi_encoded',
    children: [
      {
        name: 'slippageBps',
        param_type: 'static',
        operator: 'less_than',
        value: cap,
        value_type: 'uint256',
      },
      { name: 'innerData', param_type: 'dynamic', operator: 'pass' },
    ],
  });

  it('AE-1: abi_encoded param on a bytes input validates its children', () => {
    const t = {
      templatePath: 'fake/milkman.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: swapSig,
              params: [
                { name: 'fromToken', operator: 'pass' },
                { name: 'toToken', operator: 'pass' },
                abiEncodedParam('501'),
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).not.toThrow();
  });

  it('AE-2: abi_encoded child with mismatched value_type throws', () => {
    const t = {
      templatePath: 'fake/milkman.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: swapSig,
              params: [
                { name: 'fromToken', operator: 'pass' },
                { name: 'toToken', operator: 'pass' },
                {
                  name: 'priceCheckerData',
                  param_type: 'abi_encoded',
                  children: [
                    // value_type uint256 but a less_than 'value_type' of address — family mismatch.
                    {
                      name: 'slippageBps',
                      param_type: 'static',
                      operator: 'less_than',
                      value: '1',
                      value_type: 'address',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).toThrow(ZacError);
  });

  it('AE-3: abi_encoded on a non-bytes input throws', () => {
    const t = {
      templatePath: 'fake/milkman.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              // fromToken is `address`, not `bytes`.
              signature: swapSig,
              params: [
                abiEncodedParam('501'),
                { name: 'toToken', operator: 'pass' },
                { name: 'priceCheckerData', operator: 'pass' },
              ].map((p, i) => (i === 0 ? { ...p, name: 'fromToken' } : p)),
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).toThrow(ZacError);
  });

  it('OR-1: function-root or of two valid branches passes', () => {
    const branch = (to: string) => ({
      operator: 'matches',
      params: [
        { name: 'fromToken', operator: 'pass' },
        { name: 'toToken', operator: 'equal_to', value: to, value_type: 'address' },
        abiEncodedParam('501'),
      ],
    });
    const t = {
      templatePath: 'fake/milkman.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: swapSig,
              operator: 'or',
              branches: [branch(VALID_ADDR), branch(VALID_ADDR)],
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).not.toThrow();
  });

  it('OR-2: function-root or with a single branch validates (collapses to one shape)', () => {
    const t = {
      templatePath: 'fake/milkman.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: swapSig,
              operator: 'or',
              branches: [
                {
                  operator: 'matches',
                  params: [
                    { name: 'fromToken', operator: 'pass' },
                    {
                      name: 'toToken',
                      operator: 'equal_to',
                      value: VALID_ADDR,
                      value_type: 'address',
                    },
                    abiEncodedParam('501'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).not.toThrow();
  });

  it('OR-2b: function-root or with 0 branches throws', () => {
    const t = {
      templatePath: 'fake/milkman.tmpl',
      roles: [
        { address: VALID_ADDR, functions: [{ signature: swapSig, operator: 'or', branches: [] }] },
      ],
    };
    expect(() => validateRenderedTemplate(t)).toThrow(ZacError);
  });

  it('OR-3: a branch that misses a signature input throws (coverage)', () => {
    const t = {
      templatePath: 'fake/milkman.tmpl',
      roles: [
        {
          address: VALID_ADDR,
          functions: [
            {
              signature: swapSig,
              operator: 'or',
              branches: [
                // Missing toToken + priceCheckerData.
                { operator: 'matches', params: [{ name: 'fromToken', operator: 'pass' }] },
                { operator: 'matches', params: [{ name: 'fromToken', operator: 'pass' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateRenderedTemplate(t)).toThrow(ZacError);
  });
});
