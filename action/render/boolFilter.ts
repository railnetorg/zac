import { ZacError } from '../errors';

/**
 * Nunjucks filter: assert the input is a real boolean and pass it through.
 *
 * YAML quoting decides the type, and nunjucks decides truthiness. Together they
 * fail open on a boolean param: `borrow: false` is the boolean `false`, but
 * `borrow: "false"` is a non-empty string, which nunjucks treats as truthy — so a
 * gate written as `{% if borrow %}` opens on the value an author wrote to close
 * it. `"0"` and `"no"` behave the same way. Nothing else in the pipeline catches
 * it: `throwOnUndefined` only fires on an undefined value, and a rendered policy
 * that is wider than intended is still a valid policy.
 *
 * So a boolean param has to be asserted rather than merely tested. Run it through
 * this filter once at the top of the template and gate on the result:
 *
 *     {%- set borrow = borrow | bool("borrow") -%}
 *
 * `name` is optional and only shapes the error message; pass it, because the
 * whole point is telling the author which param they got wrong.
 */
export function bool(value: unknown, name?: string): boolean {
  if (typeof value === 'boolean') return value;

  const label = name === undefined ? 'a boolean template param' : `template param '${name}'`;
  const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value);

  throw new ZacError({
    phase: 'render',
    message:
      `${label} must be a YAML boolean, got ${typeof value} ${rendered}. ` +
      `Write \`true\` or \`false\` unquoted — a quoted "false" is a string, and a ` +
      `non-empty string is truthy, so it would silently widen the policy rather than ` +
      `restrict it.`,
  });
}
