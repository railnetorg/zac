import { z } from 'zod';
import { DeploymentConfigSchema } from './staticSchemas';
import { parseSignature } from './signatureValidation';
import { validateParamAgainstInput } from './dynamicParamSchema';
import { checkParamSanity, checkParamCoverage, checksumAddress } from './sanityChecks';
import { OperatorSchema } from './operatorSchemas';
import { ZacError } from '../errors';

type ParamYaml = Record<string, unknown> & { name: string; operator?: string };

export interface RenderedTemplate {
  /** Path to the source template (for error messages). */
  templatePath: string;
  /** Parsed YAML body — the `roles:` array. */
  roles: Array<{
    address: string;
    functions: Array<{
      signature: string;
      params?: ParamYaml[];
      /** Function-root `or` of branches (alternative to a single `params` set). */
      operator?: string;
      branches?: Array<{ operator?: string; params?: ParamYaml[] }>;
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

      // Function-root `or`: each branch is a full positional param set,
      // validated independently against the same signature.
      if (fn.operator === 'or' || fn.branches !== undefined) {
        const branches = fn.branches ?? [];
        if (branches.length === 0) {
          throw new ZacError({
            phase: 'validate',
            message: `function-level 'or' on '${fn.signature}' requires ≥ 1 branch, got 0`,
          });
        }
        for (const branch of branches) {
          if (branch.operator !== undefined && branch.operator !== 'matches') {
            throw new ZacError({
              phase: 'validate',
              message: `'or' branch operator must be 'matches' (got '${branch.operator}') on '${fn.signature}'`,
            });
          }
          validateParamsSet(branch.params ?? [], parsed);
        }
        continue;
      }

      validateParamsSet(fn.params ?? [], parsed);
    }
  }
}

/**
 * Validate one positional param set against a parsed signature: per-param
 * schema + sanity checks, bidirectional name coverage, then per-input ABI-type
 * validation. Shared by the plain `params` form and each `or` branch.
 */
function validateParamsSet(params: ParamYaml[], parsed: ReturnType<typeof parseSignature>): void {
  for (const p of params) {
    // `abi_encoded` params carry `children` instead of an `operator`; their
    // shape is validated per-input below via `validateParamAgainstInput`.
    if ((p as { param_type?: string }).param_type === 'abi_encoded') continue;
    // Strip the `name` and `param_type` fields before schema-checking the
    // operator object — the strict operator schemas reject extra keys.
    // `name` is a param-level concern handled by `checkParamCoverage`.
    // `param_type` is a spec-§2 hint (e.g. "static", "dynamic") that is
    // documented in templates but not enforced by ZAC's operator schemas.
    const { name: _name, param_type: _paramType, ...opObj } = p;
    void _name;
    void _paramType;
    OperatorSchema.parse(opObj);
    checkParamSanity(p as { operator: string; value?: unknown; value_type?: string }, p.name);
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
