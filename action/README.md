# action/

ZAC v2 CLI implementation. Module-level orientation.

## Pipeline

The `generate` command runs five phases, fail-fast:

1. **load** (`load/`) — find `config.yaml` (walk-up + `--config` override), load aliases (Nunjucks-render → YAML parse → deep last-wins merge), validate network (directory ↔ table; chain_id ↔ viem/chains).
2. **render** (`render/`) — Nunjucks-render the deployment config and per-template entries with `aliases` global and `keccak` filter.
3. **parse** (`parse/`) — eemeli/yaml `parseDocument` with `LineCounter`. Source positions retained for downstream error reporting.
4. **validate** (`validate/`) — top-level zod schema for the deployment config; recursive `OperatorSchema` (8 leaf + 8 composite operators); per-signature ABI-family rules; sanity checks (named params, address checksum).
5. **emit** (`emit/`) — merge role states by `key` (members deduped, hard-error on duplicate `(address, signature)`), serialize to YAML, write the generated file alongside the source (`*.zac.yaml` → `*.yaml`).

`sourceMap/` ships the §9.43 best-effort template-line guess used by `formatError`.

## Apply pipeline (`apply/`)

The `apply <path>` command has two flows, gated by `--revoke-unmentioned` (default: `false`):

- **Legacy per-file (default)**: `runApply` parses one generated YAML at a time and calls `planApplyRole` from `zodiac-roles-sdk` for each role key. No revokes emitted; roles not declared in any source are left untouched on the modifier.
- **Per-modifier**: with `--revoke-unmentioned=true` in directory mode, `findSafeDirs` groups sibling `*.zac.yaml` files under each `<network>/<safe-address>/` dir; `runPlanForSafeDir` aggregates the union of role keys and hands them to `zodiac-roles-sdk`'s `planApply` (which natively emits revoke calls for any role on the modifier not in the aggregated set, by diffing against the Zodiac subgraph). One Safe transaction per safe-dir.

In both flows, the resulting calls are batched into a Safe MultiSend via `@safe-global/protocol-kit`, signed with `ZAC_PROPOSER_PRIVATE_KEY`, and proposed via `@safe-global/api-kit`. The Service URL defaults from a per-chain map; `SAFE_API_KEY` is honored if set; per-chain `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`) — falling back to `RPC_URL` — overrides the public RPC used by Protocol Kit's read-only queries. `<path>` accepts a `*.zac.yaml` file or a directory.

Layout is strict: every `*.zac.yaml` must live at `<network>/<safe-address>/<name>.zac.yaml`. The `<safe-address>` dir name must match the rendered `safe_address` (case-insensitive); all siblings must agree on `(chain_id, safe_address, roles_modifier_address)`. Violations surface as `phase=validate` errors at discovery time.

Discovery is centralized in `discover.ts` (`findZacSources`, `findGeneratedConfigs`, `findPlans`, `findSafeDirs`); the CLI iterates and writes outputs alongside the source by convention (`*.zac.yaml` → `*.yaml`; safe-dir mode → `<safe-address>.plan.json` per dir; legacy mode → `<stem>.plan.json` per file).

## Adding a new operator

1. Add a zod variant to `validate/operatorSchemas.ts` discriminated union.
2. Add the ABI-family rules to `validate/dynamicParamSchema.ts`.
3. Add unit tests under `tests/test-validation/`.

## Adding a new chain

1. Extend the `NETWORKS` const in `load/networkTable.ts` (§9.57 extension is a code change).
2. The chain must already exist in `viem/chains`.
3. Add a unit test under `tests/test-aliases/networkTable.test.ts`.
4. Add the per-chain Safe Transaction Service URL to `apply/safeServiceUrl.ts` if the chain has a hosted Safe service.
