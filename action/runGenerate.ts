import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { ZacError } from './errors';
import { findConfig } from './load/findConfig';
import { loadAllAliases } from './load/loadAllAliases';
import { checkNetwork } from './load/networkCheck';
import { makeConfigEnv } from './render/configEnv';
import { renderDeploymentConfig } from './render/renderDeploymentConfig';
import { renderTemplate } from './render/renderTemplate';
import { parseYaml } from './parse/parseYaml';
import { validateDeploymentConfig, validateRenderedTemplate } from './validate/runValidate';
import { mergeRoleStates, type ConfigEntry } from './emit/mergeRoleStates';
import { serializeRoleStates } from './emit/serialize';
import { writeOutput } from './emit/writeOutput';

export interface RunGenerateOpts {
  configPath: string;
  outPath?: string;
  configOverride?: string;
}

interface ParsedTemplateFunction {
  signature: string;
  execution_options?: string;
  params?: Array<Record<string, unknown> & { name: string; operator: string }>;
}

interface ParsedTemplateRole {
  address: string;
  functions: ParsedTemplateFunction[];
}

interface ParsedTemplateBody {
  roles: ParsedTemplateRole[];
}

export async function runGenerate(opts: RunGenerateOpts): Promise<void> {
  const deploymentConfigPath = isAbsolute(opts.configPath)
    ? opts.configPath
    : resolve(opts.configPath);
  const deploymentDir = dirname(deploymentConfigPath);
  // New layout: `<network>/<safe-address>/<name>.zac.yaml` — the parent of
  // the source is the safe-address dir; the grandparent is the network.
  const network = basename(dirname(deploymentDir));

  // Phase 3 — Load
  const findArgs: { startDir: string; override?: string } = { startDir: deploymentDir };
  if (opts.configOverride !== undefined) findArgs.override = opts.configOverride;
  const configYamlPath = findConfig(findArgs);
  const aliases = loadAllAliases({ configPath: configYamlPath, network });

  // Phase 4 — Render the deployment config (using aliases)
  const env = makeConfigEnv({
    searchPaths: [deploymentDir, dirname(configYamlPath)],
    aliases: aliases.merged,
  });
  const renderedDeploymentRaw = renderDeploymentConfig(env, deploymentConfigPath);

  // Phase 5 — Parse rendered deployment
  const renderedDeploymentParsed = parseYaml(renderedDeploymentRaw);
  if (renderedDeploymentParsed.doc.errors.length > 0) {
    throw new ZacError({
      phase: 'parse',
      message: `YAML parse failed: ${renderedDeploymentParsed.doc.errors[0]!.message}`,
      sourceLocation: { file: deploymentConfigPath },
    });
  }
  const deploymentJson = renderedDeploymentParsed.doc.toJSON() as {
    chain_id: number;
    configs: Array<{
      template: string;
      key: string;
      members?: string[];
      params?: Record<string, unknown>;
    }>;
  };

  // Phase 3 follow-up — chain_id ↔ network check
  checkNetwork({ directoryName: network, declaredChainId: deploymentJson.chain_id });

  // Phase 6 — validate deployment config
  const validatedDeployment = validateDeploymentConfig(deploymentJson);

  // Layout check — the rendered safe_address must match the parent safe-dir
  // name. Mirrors the strict layout enforced by `findSafeDirs` (used by
  // plan/apply).
  const safeDirName = basename(deploymentDir);
  if (validatedDeployment.safe_address.toLowerCase() !== safeDirName.toLowerCase()) {
    throw new ZacError({
      phase: 'validate',
      message: `safe_address mismatch in ${deploymentConfigPath}: yaml says ${validatedDeployment.safe_address} but parent dir is ${safeDirName} — the dir name must match (case-insensitive) the rendered safe_address`,
      sourceLocation: { file: deploymentConfigPath },
    });
  }

  // Phase 4+5+6 — for each configs[] entry: render template, parse, validate
  const entries: ConfigEntry[] = [];
  for (const cfg of validatedDeployment.configs) {
    // Resolve template path relative to the deployment config (per §9.26).
    const templatePath = isAbsolute(cfg.template)
      ? cfg.template
      : resolve(deploymentDir, cfg.template);
    const env2 = makeConfigEnv({
      // Add the template's parent-of-parent so any template can `import` shared
      // macros from `_macros/` (which sits alongside the template's own dir).
      searchPaths: [
        dirname(templatePath),
        dirname(dirname(templatePath)),
        deploymentDir,
        dirname(configYamlPath),
      ],
      aliases: aliases.merged,
    });
    // renderTemplate uses the loader. Use the basename so the loader resolves
    // via the search paths above.
    const renderedTemplate = renderTemplate(env2, {
      templatePath: basename(templatePath),
      params: cfg.params,
    });
    const parsed = parseYaml(renderedTemplate);
    if (parsed.doc.errors.length > 0) {
      throw new ZacError({
        phase: 'parse',
        message: `YAML parse failed in ${templatePath}: ${parsed.doc.errors[0]!.message}`,
        sourceLocation: { file: templatePath },
      });
    }
    const tjson = parsed.doc.toJSON() as ParsedTemplateBody;
    validateRenderedTemplate({ templatePath, roles: tjson.roles });
    entries.push({
      key: cfg.key,
      members: cfg.members ?? [],
      roles: tjson.roles,
    });
  }

  // Phase 8 — merge + serialize + write
  const merged = mergeRoleStates(entries);
  const yaml = serializeRoleStates(merged, {
    chain_id: validatedDeployment.chain_id,
    safe_address: validatedDeployment.safe_address,
    roles_modifier_address: validatedDeployment.roles_modifier_address,
  });
  writeOutput(yaml, opts.outPath);
}
