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

  // --- stray keys ---
  //
  // Every level of the rendered document is closed against its vocabulary. A
  // key ZAC does not read is a rule its author believes is in force, and a
  // policy that is wider or narrower than intended is still a valid policy —
  // so without these the mistake renders, validates, plans and applies.
  //
  // What arrives here at runtime is a parsed YAML document; `RenderedTemplate`
  // describes that document but cannot enforce it, which is exactly why the
  // check is a runtime one. Hence the casts: they reproduce the shape a
  // template can actually render, which the interface has no way to express.
  type Rendered = Parameters<typeof validateRenderedTemplate>[0];
  const rendered = (roles: unknown): Rendered =>
    ({ templatePath: 'fake/aave.tmpl', roles }) as Rendered;
  const oneFunction = (fn: unknown): Rendered =>
    rendered([{ address: VALID_ADDR, functions: [fn] }]);

  it('SK-6: a stray key on a role is rejected', () => {
    expect(() =>
      validateRenderedTemplate(rendered([{ address: VALID_ADDR, functions: [], stray_key: 'x' }])),
    ).toThrow(
      /unknown key 'stray_key' at fake\/aave\.tmpl roles\[0\] — allowed: address, functions/,
    );
  });

  it('SK-7: a stray key on a function is rejected, positioned by index', () => {
    expect(() =>
      validateRenderedTemplate(
        rendered([
          {
            address: VALID_ADDR,
            functions: [
              { signature: approveSig, params: approveParams },
              { signature: approveSig, params: approveParams, stray_key: 'x' },
            ],
          },
        ]),
      ),
    ).toThrow(/at fake\/aave\.tmpl roles\[0\]\.functions\[1\]/);
  });

  it('SK-8: `execution_option` (singular) is rejected rather than read as `none`', () => {
    // The typo that motivates the whole check: it renders a role that cannot
    // attach ETH, and reads exactly like one that can. Nothing downstream
    // would complain — `none` is a perfectly valid policy.
    expect(() =>
      validateRenderedTemplate(
        oneFunction({ signature: approveSig, execution_option: 'send', params: approveParams }),
      ),
    ).toThrow(/unknown key 'execution_option'/);
  });

  it('SK-9: a stray key on an `or` branch is rejected', () => {
    expect(() =>
      validateRenderedTemplate(
        oneFunction({
          signature: approveSig,
          operator: 'or',
          branches: [
            { operator: 'matches', params: approveParams },
            { operator: 'matches', params: approveParams, stray_key: 'x' },
          ],
        }),
      ),
    ).toThrow(
      /unknown key 'stray_key' at fake\/aave\.tmpl roles\[0\]\.functions\[0\]\.branches\[1\] — allowed: operator, params/,
    );
  });

  it('SK-10: a stray key on an ordinary param is rejected, naming the operator', () => {
    // Closed by the strict operator schemas rather than by a listed
    // vocabulary — the allowed set is per-operator, so the message names the
    // operator the key is not part of.
    expect(() =>
      validateRenderedTemplate(
        oneFunction({
          signature: approveSig,
          params: [{ ...approveParams[0], stray_key: 'x' }, approveParams[1]],
        }),
      ),
    ).toThrow(/unknown key 'stray_key' at .* — not declared by operator 'equal_to'/);
  });

  it('SK-11: a stray key on an abi_encoded param is rejected', () => {
    // The one param shape with no operator object to be closed against.
    expect(() =>
      validateRenderedTemplate(
        rendered([
          {
            address: VALID_ADDR,
            functions: [
              {
                signature: swapSig,
                params: [
                  { name: 'fromToken', operator: 'pass' },
                  { name: 'toToken', operator: 'pass' },
                  { ...abiEncodedParam('501'), stray_key: 'x' },
                ],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/unknown key 'stray_key' at .* — allowed: name, param_type, children/);
  });

  it('SK-12: `children` on a param that is not abi_encoded is rejected', () => {
    // `children` is read only on the `abi_encoded` branch, so anywhere else
    // it declares a nested layout that nothing will decode.
    expect(() =>
      validateRenderedTemplate(
        oneFunction({
          signature: approveSig,
          params: [{ ...approveParams[0], children: [] }, approveParams[1]],
        }),
      ),
    ).toThrow(/unknown key 'children'/);
  });

  it('SK-13: a stray key on an abi_encoded child is rejected', () => {
    const param = abiEncodedParam('501');
    expect(() =>
      validateRenderedTemplate(
        rendered([
          {
            address: VALID_ADDR,
            functions: [
              {
                signature: swapSig,
                params: [
                  { name: 'fromToken', operator: 'pass' },
                  { name: 'toToken', operator: 'pass' },
                  {
                    ...param,
                    children: [{ ...param.children[0], stray_key: 'x' }, param.children[1]],
                  },
                ],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/unknown key 'stray_key' at abi_encoded child 'slippageBps' of 'priceCheckerData'/);
  });

  it('SK-14: a bogus `param_type` is rejected instead of read as no declaration', () => {
    expect(() =>
      validateRenderedTemplate(
        oneFunction({
          signature: approveSig,
          params: [{ ...approveParams[0], param_type: 'statik' }, approveParams[1]],
        }),
      ),
    ).toThrow(/param_type "statik" at .* is not one of static \| dynamic \| tuple \| abi_encoded/);
  });

  it('SK-15: a document whose shape the interface only claims is rejected, not crashed on', () => {
    // `roles` and `functions` reach this function straight out of the YAML
    // parser. A template that renders neither used to fault here on a
    // property of `undefined` instead of reporting a policy error.
    expect(() => validateRenderedTemplate(rendered(undefined))).toThrow(
      /fake\/aave\.tmpl must render a 'roles:' list/,
    );
    expect(() =>
      validateRenderedTemplate(rendered([{ address: VALID_ADDR, function: [] }])),
    ).toThrow(ZacError);
    expect(() => validateRenderedTemplate(rendered([{ address: VALID_ADDR }]))).toThrow(
      /roles\[0\]\.functions must be a list/,
    );
  });
});
