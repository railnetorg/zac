/**
 * Nunjucks filter: the swap allow-list for the Milkman template — the cartesian product
 * `from_tokens × to_tokens`, MINUS self-pairs (`from === to.token`).
 *
 * A config that lists a token in both `from_tokens` and `to_tokens` (to allow buy AND sell)
 * would otherwise emit a nonsensical X→X branch. Filtering here lets the template both skip
 * those and collapse to a plain `matches` when exactly one real pair remains (a 1-branch `or`
 * is degenerate and rejected at apply time).
 *
 *   {%- set pairs = from_tokens | milkman_pairs(to_tokens) -%}
 *
 * Returns an ordered list of `{ from, to }`, where `from` is the from-token key and `to` is the
 * original to-token object (token / max_slippage_bps / feeds / reverses).
 */
export function milkmanPairs(
  fromTokens: unknown,
  toTokens: unknown,
): Array<{ from: string; to: unknown }> {
  if (!Array.isArray(fromTokens) || !fromTokens.every((t) => typeof t === 'string')) {
    throw new Error('milkman_pairs: piped value must be an array of from-token keys (strings)');
  }
  if (!Array.isArray(toTokens)) {
    throw new Error('milkman_pairs: argument must be an array of to-token objects');
  }

  const pairs: Array<{ from: string; to: unknown }> = [];
  for (const from of fromTokens as string[]) {
    for (const to of toTokens) {
      const toKey = (to as { token?: unknown } | null)?.token;
      if (typeof toKey !== 'string') {
        throw new Error('milkman_pairs: each to_token must be an object with a string `token`');
      }
      if (from === toKey) continue; // skip self-pair (X → X)
      pairs.push({ from, to });
    }
  }
  return pairs;
}
