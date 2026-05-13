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

The `apply <path>` command parses the generated YAML, calls `planApplyRole` from `zodiac-roles-sdk` for each role key (which diffs the desired state against the on-chain state via the Gnosis Guild subgraph), batches the resulting calls into a single Safe MultiSend via `@safe-global/protocol-kit`, signs the Safe transaction hash with `ZAC_PROPOSER_PRIVATE_KEY`, and proposes it to the Safe Transaction Service via `@safe-global/api-kit`. The Service URL defaults from a per-chain map; `SAFE_API_KEY` is honored if set; `RPC_URL` overrides the public RPC used by Protocol Kit's read-only queries. `<path>` accepts a generated `.yaml` file or a directory (walked recursively — only generated files with a sibling `*.zac.yaml` are applied).

Discovery is centralized in `discover.ts` (`findZacSources`, `findGeneratedConfigs`, `findPlans`); the CLI iterates and writes outputs alongside the source by convention (`*.zac.yaml` → `*.yaml` → `*.plan.json`).

## Adding a new operator

1. Add a zod variant to `validate/operatorSchemas.ts` discriminated union.
2. Add the ABI-family rules to `validate/dynamicParamSchema.ts`.
3. Add unit tests under `tests/test-validation/`.

## Adding a new chain

1. Extend the `NETWORKS` const in `load/networkTable.ts` (§9.57 extension is a code change).
2. The chain must already exist in `viem/chains`.
3. Add a unit test under `tests/test-aliases/networkTable.test.ts`.
4. Add the per-chain Safe Transaction Service URL to `apply/safeServiceUrl.ts` if the chain has a hosted Safe service.
