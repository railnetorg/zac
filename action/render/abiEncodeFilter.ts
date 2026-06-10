import { encodeAbiParameters, type AbiParameter } from 'viem';

/**
 * Nunjucks filter: ABI-encode `values` against `types` and return the hex blob —
 * the template-side equivalent of Solidity's `abi.encode(...)`.
 *
 * Used to pin an opaque dynamic-`bytes` param to an exact value computed from
 * structured inputs known at policy-creation time. For example, the Milkman
 * price checker's `innerData` is `abi.encode(address[] feeds, bool[] reverses)`;
 * leaving it free lets the caller choose the feeds the slippage check measures
 * against, so the template pins it:
 *
 *   value: "{{ [feeds, reverses] | abi_encode(['address[]', 'bool[]']) }}"
 *
 * The piped value is the ordered list of values; the filter argument is the
 * matching list of ABI type strings. `encodeAbiParameters` validates each value
 * against its declared type (and address checksums), throwing on a mismatch —
 * which `renderTemplate` surfaces as a `phase: 'render'` ZacError.
 */
export function abiEncode(values: unknown, types: unknown): string {
  if (!Array.isArray(types) || !types.every((t) => typeof t === 'string')) {
    throw new Error("abi_encode: 'types' argument must be an array of ABI type strings");
  }
  if (!Array.isArray(values)) {
    throw new Error('abi_encode: piped value must be an array of values to encode');
  }
  if (values.length !== types.length) {
    throw new Error(
      `abi_encode: expected ${types.length} value(s) to match ${types.length} type(s), got ${values.length}`,
    );
  }
  const params: AbiParameter[] = (types as string[]).map((type) => ({ type }));
  return encodeAbiParameters(params, values);
}
