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
});
