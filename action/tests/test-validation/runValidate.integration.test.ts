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

  // --- execution_options ---
  //
  // The allowed set is also enforced at apply time by `executionFlags`
  // (fail-closed, and the boundary that maps to the SDK). These cases pin
  // that an author hears about a typo in the same phase as every other
  // policy error instead of at plan or apply time.

  const approveSig = 'function approve(address spender, uint256 amount)';
  const approveParams = [
    { name: 'spender', operator: 'equal_to', value: VALID_ADDR, value_type: 'address' },
    { name: 'amount', operator: 'pass' },
  ];
  const withExecutionOptions = (
    execution_options?: string,
  ): Parameters<typeof validateRenderedTemplate>[0] => ({
    templatePath: 'fake/lido.tmpl',
    roles: [
      {
        address: VALID_ADDR,
        functions: [
          {
            signature: approveSig,
            ...(execution_options === undefined ? {} : { execution_options }),
            params: approveParams,
          },
        ],
      },
    ],
  });

  it('EO-1: every value in the taxonomy is accepted, and omitting the key is too', () => {
    for (const value of [undefined, 'none', 'send', 'delegatecall', 'both']) {
      expect(() => validateRenderedTemplate(withExecutionOptions(value))).not.toThrow();
    }
  });

  it('EO-2: a wrong-case value is rejected at validate time with the field and the allowed set', () => {
    // `"Send"` is the SDK's own spelling of the enum member and the typo an
    // author is most likely to reach for.
    expect(() => validateRenderedTemplate(withExecutionOptions('Send'))).toThrow(ZacError);
    expect(() => validateRenderedTemplate(withExecutionOptions('Send'))).toThrow(
      /execution_options "Send" on 'function approve\(address spender, uint256 amount\)' is not one of none \| send \| delegatecall \| both/,
    );
  });

  it('EO-3: an invented value is rejected and the error carries phase=validate', () => {
    let caught: unknown;
    try {
      validateRenderedTemplate(withExecutionOptions('sendValue'));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZacError);
    expect((caught as ZacError).phase).toBe('validate');
    expect((caught as ZacError).message).toContain('none | send | delegatecall | both');
  });

  it('EO-4: an empty string is rejected — it is not the same as omitting the key', () => {
    expect(() => validateRenderedTemplate(withExecutionOptions(''))).toThrow(ZacError);
  });
});
