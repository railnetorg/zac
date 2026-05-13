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

- Source configs: `*.zac.yaml` MUST live at `configs/<network>/<safe-address>/<name>.zac.yaml` (e.g. `configs/mainnet/0xAbCd…1234/aave_v3.zac.yaml`). The `<safe-address>` directory name must match the rendered `safe_address` (case-insensitive); all `*.zac.yaml` siblings in one safe-dir must agree on `(chain_id, safe_address, roles_modifier_address)`.
- Generated configs: `*.yaml` next to the source (`aave_v3.zac.yaml` → `aave_v3.yaml`).
- Plan files:
  - default (`--revoke-unmentioned=true`): one `<safe-address>.plan.json` per safe-dir — the SDK's `planApply` aggregates roles across siblings and natively revokes any role on the modifier not in the aggregated set.
  - `--revoke-unmentioned=false`: legacy `<stem>.plan.json` next to each generated file — `planApplyRole` is called per source, no revokes.

## Try the example

```
bun ./action/cli.ts generate examples/mainnet/0x3333333333333333333333333333333333333333/aave_safe.zac.yaml   # one file
bun ./action/cli.ts generate examples/mainnet/                                                                # whole dir, recursive
```

## Apply

After generating the YAML, propose the role updates to the Safe Transaction Service for signing by the Safe's owners:

```
export ZAC_PROPOSER_PRIVATE_KEY=0x...   # a Safe owner's private key (never logged)
bun run zac apply <path>                # path is a generated `.yaml` file or a directory
```

`apply` is plan + submit in one shot. To split them (e.g. for review):

```
bun run zac plan   <path>   # default: one <safe-address>.plan.json per safe-dir
bun run zac submit <path>   # posts every *.plan.json found under <path>, bundled per safe
```

Pass `--revoke-unmentioned=false` to keep the legacy per-file flow (one `<stem>.plan.json` per source, no revokes). The flag is structurally meaningless for single-file mode (one role → no aggregation), so it's silently ignored when `<path>` is a single `*.zac.yaml`.

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
