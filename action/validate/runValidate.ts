import { z } from 'zod';
import { DeploymentConfigSchema } from './staticSchemas';
import { parseSignature } from './signatureValidation';
import { validateParamAgainstInput } from './dynamicParamSchema';
import { checkParamSanity, checkParamCoverage, checksumAddress } from './sanityChecks';
import { OperatorSchema } from './operatorSchemas';
import { ZacError } from '../errors';

export interface RenderedTemplate {
  /** Path to the source template (for error messages). */
  templatePath: string;
  /** Parsed YAML body — the `roles:` array. */
  roles: Array<{
    address: string;
    functions: Array<{
      signature: string;
      params?: Array<Record<string, unknown> & { name: string; operator: string }>;
    }>;
  }>;
}

/**
 * Validate one rendered template entry. Fail-fast: throws on the first error.
 * Phase 6 keeps this orchestrator minimal — Phase 7+ wires in source positions
 * via the parse-phase `sourceMap`.
 */
export function validateRenderedTemplate(t: RenderedTemplate): void {
  for (const role of t.roles) {
    // Throws if address is invalid; result is unused at this phase but the
    // call still acts as the validation gate.
    checksumAddress(role.address, `${t.templatePath} role.address`);

    for (const fn of role.functions) {
      const parsed = parseSignature(fn.signature);
      const params = fn.params ?? [];

      for (const p of params) {
        // Strip the `name` field before schema-checking the operator object —
        // the strict operator schemas reject extra keys, and `name` is a
        // param-level concern handled by `checkParamCoverage`.
        const { name: _name, ...opObj } = p;
        void _name;
        OperatorSchema.parse(opObj);
        checkParamSanity(p, p.name);
      }

      checkParamCoverage(
        params.map((p) => p.name),
        parsed.inputs.map((i) => i.name ?? ''),
      );

      for (const input of parsed.inputs) {
        const param = params.find((pp) => pp.name === input.name);
        if (!param) continue; // covered by checkParamCoverage above
        validateParamAgainstInput(param, input as Parameters<typeof validateParamAgainstInput>[1]);
      }
    }
  }
}

/**
 * Validate the top-level deployment config (rendered + parsed YAML). Returns
 * the typed config on success; throws `ZacError({ phase: 'validate' })` with
 * the first zod issue surfaced as a flat path.
 */
export function validateDeploymentConfig(
  rendered: unknown,
): z.infer<typeof DeploymentConfigSchema> {
  const result = DeploymentConfigSchema.safeParse(rendered);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new ZacError({
      phase: 'validate',
      message: `${first.path.join('.')}: ${first.message}`,
    });
  }
  return result.data;
}
