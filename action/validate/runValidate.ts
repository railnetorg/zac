import { z } from 'zod';
import { DeploymentConfigSchema } from './staticSchemas';
import { parseSignature } from './signatureValidation';
import { validateParamAgainstInput } from './dynamicParamSchema';
import { checkParamSanity, checkParamCoverage, checksumAddress } from './sanityChecks';
import { parseOperatorObject } from './operatorSchemas';
import { checkExecutionOptions } from './executionOptionsSchema';
import { checkParamType } from './paramTypeSchema';
import {
  ABI_ENCODED_PARAM_KEYS,
  BRANCH_KEYS,
  FUNCTION_KEYS,
  ROLE_KEYS,
  checkNoStrayKeys,
} from './strayKeys';
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
      /** Roles V2 `ExecutionOptions`, lowercase; absent means `none`. */
      execution_options?: string;
      params?: ParamYaml[];
      /** Function-root `or` of branches (alternative to a single `params` set). */
      operator?: string;
      branches?: Array<{ operator?: string; params?: ParamYaml[] }>;
    }>;
  }>;
}

/**
 * Validate one rendered template entry. Fail-fast: throws on the first error.
 *
 * `RenderedTemplate` describes the shape; it does not enforce it. What arrives
 * here is whatever the template rendered and the YAML parser produced, cast to
 * that interface by the caller — so the walk below both checks the policy and
 * establishes that the document has the shape the type claims. Every node is
 * closed against its key vocabulary (`strayKeys.ts`), because a key ZAC does
 * not read is a rule the author believes is in force and is not.
 *
 * Positions in the error messages are indexed paths into the rendered
 * document (`roles[0].functions[2].params[1]`), which is what an author has in
 * front of them when a template's own line numbers do not correspond to it.
 */
export function validateRenderedTemplate(t: RenderedTemplate): void {
  if (!Array.isArray(t.roles)) {
    throw new ZacError({
      phase: 'validate',
      message: `${t.templatePath} must render a 'roles:' list`,
    });
  }

  for (const [i, role] of t.roles.entries()) {
    const roleWhere = `${t.templatePath} roles[${i}]`;
    checkNoStrayKeys(role, ROLE_KEYS, roleWhere);
    // Throws if address is invalid; result is unused at this phase but the
    // call still acts as the validation gate.
    checksumAddress(role.address, `${roleWhere}.address`);

    if (!Array.isArray(role.functions)) {
      throw new ZacError({
        phase: 'validate',
        message: `${roleWhere}.functions must be a list`,
      });
    }

    for (const [j, fn] of role.functions.entries()) {
      const fnWhere = `${roleWhere}.functions[${j}]`;
      checkNoStrayKeys(fn, FUNCTION_KEYS, fnWhere);
      const parsed = parseSignature(fn.signature);
      checkExecutionOptions(fn.execution_options, fn.signature);

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
        for (const [k, branch] of branches.entries()) {
          const branchWhere = `${fnWhere}.branches[${k}]`;
          checkNoStrayKeys(branch, BRANCH_KEYS, branchWhere);
          if (branch.operator !== undefined && branch.operator !== 'matches') {
            throw new ZacError({
              phase: 'validate',
              message: `'or' branch operator must be 'matches' (got '${branch.operator}') on '${fn.signature}'`,
            });
          }
          validateParamsSet(branch.params ?? [], parsed, branchWhere);
        }
        continue;
      }

      validateParamsSet(fn.params ?? [], parsed, fnWhere);
    }
  }
}

/**
 * Validate one positional param set against a parsed signature: per-param
 * schema + sanity checks, bidirectional name coverage, then per-input ABI-type
 * validation. Shared by the plain `params` form and each `or` branch, which is
 * why the position prefix comes in as `where`.
 */
function validateParamsSet(
  params: ParamYaml[],
  parsed: ReturnType<typeof parseSignature>,
  where: string,
): void {
  if (!Array.isArray(params)) {
    throw new ZacError({ phase: 'validate', message: `${where}.params must be a list` });
  }

  for (const [i, p] of params.entries()) {
    const name = (p as { name?: unknown }).name;
    const paramWhere =
      typeof name === 'string' ? `${where}.params[${i}] ('${name}')` : `${where}.params[${i}]`;
    checkParamType((p as { param_type?: unknown }).param_type, paramWhere);

    // `abi_encoded` params carry `children` instead of an `operator`, so the
    // strip-and-parse below has no operator object to close them against;
    // `ABI_ENCODED_PARAM_KEYS` is their whole vocabulary instead. The children
    // are validated per-input below via `validateParamAgainstInput`.
    if ((p as { param_type?: string }).param_type === 'abi_encoded') {
      checkNoStrayKeys(p, ABI_ENCODED_PARAM_KEYS, paramWhere);
      continue;
    }

    // Strip the `name` and `param_type` fields before schema-checking the
    // operator object — the strict operator schemas reject extra keys, and
    // that is what closes an ordinary param's vocabulary.
    // `name` is a param-level concern handled by `checkParamCoverage`.
    // `param_type` is a spec-§2 hint (e.g. "static", "dynamic") that declares
    // the calldata layout rather than a condition.
    // `display_decode` is a plan-visualization hint (ABI layout of a pinned
    // `bytes` value); like `param_type` it isn't part of the operator taxonomy.
    const { name: _name, param_type: _paramType, display_decode: _displayDecode, ...opObj } = p;
    void _name;
    void _paramType;
    void _displayDecode;
    parseOperatorObject(opObj, paramWhere);
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
    // An unrecognized key is reported against the object that holds it, so
    // its path is empty at the top level and the message already names the
    // key. Prefixing an empty path would just print a bare colon.
    const at = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    throw new ZacError({
      phase: 'validate',
      message: `${at}${first.message}`,
    });
  }
  return result.data;
}
