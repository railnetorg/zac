# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

ZAC v2 (Zodiac Roles V2 config generator). A Bun + TypeScript CLI named `zac` that turns curated YAML role configs into Zodiac Roles V2 role-state-update calls, then proposes them as Safe transactions via the Safe Transaction Service. Foundry contracts and fork tests back the templates.

Spec: <https://www.notion.so/357c1910fb6e80a7b2b8f391ae421040>.

## Commands

All commands are wrapped by `just` (see `justfile`). Common workflow:

```
just install               # init submodules + bun install in action/
just contracts-build       # forge build --sizes
just contracts-test        # forge test -vvv (excludes fork tests via no_match_path)
just action-test           # vitest run
just action-lint           # eslint .
just action-format[-check] # prettier write / check
just action-typecheck      # tsc --noEmit
just action-audit          # bun audit
```

Run a single TS test file: `cd action && bun run vitest run tests/test-validation/operatorSchemas.test.ts`. Watch mode: `cd action && bun run test:watch`.

Run a single Solidity test: `cd foundry && forge test --match-path test/Counter.t.sol -vvv`.

### Fork tests (opt-in, local only)

Fork tests live under `foundry/test/fork/` — both the contract fork tests (`FlashLoanHelperFork.t.sol`) and the per-template ZAC policy tests under `foundry/test/fork/templates/` (which share the `foundry/test/zac/ZacForkTest.sol` harness). They require a live upstream RPC. The default profile excludes them via `no_match_path = "test/{zac,fork}/**"`; the `contracts-fork` profile (`foundry/foundry.toml`) re-points `test` at `test/fork`, enables `ffi`, and grants fs access for `../examples`, `../action`, `../templates`, `../aliases`, `test/fork/templates/test_config`, `cache`, and `/tmp`.

```
just forge-test-fork https://your-upstream-rpc.example
# or manually:
cd foundry && FOUNDRY_PROFILE=contracts-fork MAINNET_RPC_URL=https://your-upstream-rpc.example forge test -vvv
```

`MAINNET_RPC_URL` points directly at the upstream RPC — the tests fork it natively with `vm.createSelectFork(vm.envString("MAINNET_RPC_URL"))` (no separate anvil instance), and hard-fail if it is unset. There is no CI workflow for fork tests by design.

## CLI usage

Four subcommands. Each accepts a file OR a directory (walked recursively). Outputs are written **alongside** the source.

```
bun ./action/cli.ts generate <path>   # *.zac.yaml → sibling *.yaml
bun ./action/cli.ts plan     <path>   # generated *.yaml → sibling *.plan.json
bun ./action/cli.ts submit   <path>   # *.plan.json → Safe Transaction Service
bun ./action/cli.ts apply    <path>   # plan + submit in one shot
```

Host repos add the CLI as a submodule and expose it via `"zac": "bun ./submodules/zac/action/cli.ts"` in `package.json`.

### Layout invariants (enforced at discovery time)

Every `*.zac.yaml` MUST live at `<network>/<safe-address>/<name>.zac.yaml`:

- `<safe-address>` dir name must match the rendered `safe_address` (case-insensitive).
- All `*.zac.yaml` siblings in one safe-dir must agree on `(chain_id, safe_address, roles_modifier_address)`.
- Network dir names are case-sensitive lowercase canonical (`mainnet`, `base`, `sepolia`, …).

Violations surface as `phase=validate` errors. Discovery is centralized in `action/discover.ts` (`findZacSources`, `findGeneratedConfigs`, `findSafeYamls`, `findPlans`, `findSafeDirs`).

### `--revoke-unmentioned` (plan/apply only)

- `true` (default) + directory mode: `findSafeDirs` groups siblings under each `<network>/<safe-address>/`. `runPlanForSafeDir` aggregates role keys and calls `planApply`, which natively diffs against the Zodiac subgraph and emits revokes for any role on the modifier not in the aggregated set. One `<safe-address>.plan.json` per safe-dir → one Safe transaction. This is also the only mode that consults `safe.yaml` for Safe-level config (guard/fallback/modules).
- `false`: legacy per-file mode. Each source → `<stem>.plan.json` via the SDK's `planApplyRole`. No revokes; unmentioned roles untouched; `safe.yaml` ignored.
- File-mode is always per-file legacy regardless of the flag; an explicit `--revoke-unmentioned=true` there is a no-op and triggers a stderr WARN (`warnIfFileFlagNoOp`).

A safe-dir must NOT mix per-file plans and an aggregated plan; `assertNoMixedSafeDirPlans` (in `cli.ts`) rejects this before submit.

### Env vars

- `ZAC_PROPOSER_PRIVATE_KEY` — required for `apply`/`submit` (a Safe owner key; never logged).
- `SAFE_API_KEY` — optional, forwarded to api-kit if rate-limited.
- `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`) — per-chain RPC for Safe / role-state reads (the proposal nonce itself comes from the Safe Transaction Service, see Apply pipeline).
- `RPC_URL` — universal fallback.
- `--rpc-url` CLI flag overrides both.

If no RPC is resolvable for a chain in scope, the run errors out before touching the chain.

## Architecture

### Generate pipeline (fail-fast, five phases)

`runGenerate` in `action/runGenerate.ts` runs these in order. Each phase has its own directory under `action/`:

1. **load** (`load/`) — find `config.yaml` (walk-up + `--config` override), Nunjucks-render alias files then YAML-parse + deep last-wins merge, validate network (directory ↔ `networkTable` ↔ `viem/chains`).
2. **render** (`render/`) — Nunjucks-render the deployment config and per-template entries with `aliases` global and `keccak` filter.
3. **parse** (`parse/`) — `eemeli/yaml` `parseDocument` with `LineCounter`; source positions retained for error reporting.
4. **validate** (`validate/`) — top-level zod schema; recursive `OperatorSchema` (9 leaf + 7 composite operators); per-signature ABI-family rules; sanity checks (named params, checksummed addresses).
5. **emit** (`emit/`) — merge role states by `key` (members deduped; hard-error on duplicate `(address, signature)`), serialize to YAML, write alongside source (`*.zac.yaml` → `*.yaml`).

`sourceMap/templateLineGuess.ts` ships the best-effort template-line guess used by `formatError`. Errors carry `{ phase, message, sourceLocation? }` (see `action/errors.ts`).

### Apply pipeline (`action/apply/`)

`runApply` (per-file) and `runApplyForSafeDir` (aggregated) each chain `runPlan*` then `runSubmit`. The CLI dispatches the two stages explicitly so the diff (`printPlanDiff`) prints between plan and submit. Calls are batched into a Safe MultiSend via `@safe-global/protocol-kit`, signed with `ZAC_PROPOSER_PRIVATE_KEY`, posted via `@safe-global/api-kit`. Service URL comes from `apply/safeServiceUrl.ts`'s per-chain map.

Nonce: `runBundledSubmit` resolves the proposal nonce via `resolveProposalNonce` (`apply/safeApi.ts`) BEFORE building the Safe tx — it calls api-kit's `getNextNonce` (next nonce *after* the highest pending queued proposal) rather than letting protocol-kit default to the on-chain nonce, which would collide with / replace pending proposals. The plan JSON stores no nonce; it's always resolved fresh at submit. `submit`/`apply` accept `--nonce <n>` to override (e.g. to deliberately replace a specific pending proposal) — in directory-mode the override applies to every per-Safe bundle, so only pass it when targeting one Safe. If no Safe Transaction Service is reachable for the chain, nonce resolution degrades to the on-chain default (and `signAndPropose` then raises the no-service error).

`apply/printPlanDiff` annotates `scopeFunction`/`revokeFunction` calls with user-defined function names (`buildSelectorMap`), expanded param trees (`buildFunctionParamMap`, `renderParamTree`), and address labels from the alias registry (`buildAddressLabelMap`). These three builders are best-effort — parse failures degrade silently to raw hex.

SDK imports (`zodiac-roles-sdk`) are lazy throughout — the module is heavy and would slow `--help`.

### Templates and aliases

- `templates/<protocol>/*.tmpl` — Nunjucks role-template fragments. `templates/_macros/common.tmpl` is shared.
- `aliases/<network>/*.yaml` — curated per-chain registries (tokens, contract handles, etc.) shipped with ZAC.
- Host repos add their own `config.yaml` pointing at additional alias files (signers, modifiers, safes). See `examples/config.yaml` for the canonical shape.

### Adding stuff

- **New operator**: add a zod variant to `validate/operatorSchemas.ts` discriminated union; add ABI-family rules to `validate/dynamicParamSchema.ts`; add unit tests under `tests/test-validation/`.
- **New chain**: extend `NETWORKS` in `load/networkTable.ts` (the chain must already exist in `viem/chains`); add a unit test under `tests/test-aliases/networkTable.test.ts`; add the per-chain Safe Transaction Service URL to `apply/safeServiceUrl.ts` if hosted.

### Foundry side

`foundry/src/` holds `Counter` (the default-profile scaffold) and `FlashLoanHelper` (+ `interfaces/IFlashLoanHelper.sol`), the substantive contract. The fork-only Solidity work lives behind the `contracts-fork` profile: the `foundry/test/zac/ZacForkTest.sol` harness plus the per-template policy tests under `foundry/test/fork/templates/`. The harness's `applyConfigFile(fx, member, fixtureName)`:

1. Substitutes runtime placeholders (`__MODIFIER__`, `__SAFE__`, `__MEMBER__`, `__TEMPLATES__`) into a fixture `.zac.yaml` from `test/fork/templates/test_config/`, writing it under `cache/zac-fork-test/mainnet/<safe>/` (the CLI's required `<network>/<safe>/` layout).
2. FFIs `zac generate <configPath>` then `zac plan <generated>` (read-only), reading the resulting `*.plan.json`.
3. Executes each planned role-state-update call against the Modifier as the Safe via `vm.prank(owner)` + `to.call(data)` — owner-gated, so it bypasses `execTransaction` threshold/signatures. Fine for *configuring* the role.

Tests that exercise the real `execTransactionWithRole` path do NOT short-circuit — see `expectPolicyReject`, which asserts the Roles `ConditionViolation` selector. (Everything runs inside forge's native `vm.createSelectFork`; no anvil RPC choreography.)
