# zac

Zodiac Roles V2 config generator (CLI) plus the Foundry contracts that back it.

ZAC v2 is a Bun + TypeScript CLI named `zac`. Sole command: `generate`. The pipeline is load → render → parse → validate → emit, fail-fast.

Spec: <https://www.notion.so/357c1910fb6e80a7b2b8f391ae421040>.

## Layout

- `foundry/` — Solidity contracts (Foundry project: `src/`, `test/`, `script/`, `lib/`).
- `action/` — ZAC CLI (Bun + TypeScript): `cli.ts`, `load/`, `render/`, `parse/`, `validate/`, `emit/`, `sourceMap/`, plus `tests/`.
- `templates/` — Curated role templates shipped with ZAC (`aave_v3.tmpl`, `_macros/`).
- `aliases/` — Curated per-chain alias library (`mainnet/aave.yaml`, `mainnet/tokens.yaml`).
- `examples/` — End-to-end deployment example (`config.yaml`, `mainnet/aave_safe.zac.yaml`).

## Usage (host repos)

Add ZAC as a submodule, then in your `package.json`:

```
"scripts": {
  "zac": "bun ./submodules/zac/action/cli.ts"
}
```

Run:

```
bun run zac generate <path>     # path is a `*.zac.yaml` file or a directory (walked recursively)
```

The CLI is directory-driven: every subcommand accepts either a single file or a directory, and writes outputs **alongside** the source. Conventions:

- Source configs: `*.zac.yaml` (e.g. `configs/mainnet/aave_v3.zac.yaml`).
- Generated configs: `*.yaml` next to the source (`aave_v3.zac.yaml` → `aave_v3.yaml`).
- Plan files: `*.plan.json` next to the generated file (`aave_v3.plan.json`).

## Try the example

```
bun ./action/cli.ts generate examples/mainnet/aave_safe.zac.yaml   # one file
bun ./action/cli.ts generate examples/mainnet/                     # whole dir, recursive
```

## Apply

After generating the YAML, propose the role updates to the Safe Transaction Service for signing by the Safe's owners:

```
export ZAC_PROPOSER_PRIVATE_KEY=0x...   # a Safe owner's private key (never logged)
bun run zac apply <path>                # path is a generated `.yaml` file or a directory
```

`apply` is plan + submit in one shot. To split them (e.g. for review):

```
bun run zac plan   <path>   # writes <stem>.plan.json alongside each generated file
bun run zac submit <path>   # posts every <stem>.plan.json found under <path>
```

The proposer signs and submits the transaction proposal; other Safe owners then sign in the Safe UI. Optional env vars: `SAFE_API_KEY` (forwarded to api-kit if rate-limited) and `RPC_URL` (overrides the default per-chain public RPC used by Safe Protocol Kit for read-only queries).

## Commands

```
just install               # install foundry submodules + bun deps
just contracts-build       # forge build
just contracts-test        # forge test
just action-test           # vitest
just action-lint           # eslint
just action-format         # prettier write
just action-format-check   # prettier check
just action-typecheck      # tsc --noEmit
just action-audit          # bun audit
```
