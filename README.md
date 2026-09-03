# zac

Zodiac Roles V2 config generator (CLI) plus the Foundry contracts that back it.

ZAC v2 is a Bun + TypeScript CLI named `zac`. Four subcommands: `generate`, `plan`, `apply`, `submit`. The generate pipeline is load → render → parse → validate → emit, fail-fast; plan/apply/submit drive the Safe Transaction Service round-trip.

Spec: <https://www.notion.so/357c1910fb6e80a7b2b8f391ae421040>.

## Layout

- `foundry/` — Solidity contracts (Foundry project: `src/`, `test/`, `script/`, `lib/`).
- `action/` — ZAC CLI (Bun + TypeScript): `cli.ts`, `load/`, `render/`, `parse/`, `validate/`, `emit/`, `sourceMap/`, plus `tests/`.
- `templates/` — Curated role templates shipped with ZAC (`aave_v3.tmpl`, `_macros/`).
- `aliases/` — Curated per-chain alias library (`mainnet/aave.yaml`, `mainnet/tokens.yaml`).
- `examples/` — End-to-end deployment example (`config.yaml`, `mainnet/<safe-address>/aave_safe.zac.yaml`).

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

- Source configs: `*.zac.yaml` MUST live at `<network>/<safe-address>/<name>.zac.yaml` (e.g. `configs/mainnet/0xAbCd…1234/aave_v3.zac.yaml`). The `<safe-address>` directory name must match the rendered `safe_address` (case-insensitive); all `*.zac.yaml` siblings in one safe-dir must agree on `(chain_id, safe_address, roles_modifier_address)`. Network directory names are case-sensitive and must match the canonical lowercase form (`mainnet`, `base`, `sepolia`, …).
- Generated configs: `*.yaml` next to the source (`aave_v3.zac.yaml` → `aave_v3.yaml`).
- Plan files:
  - default (`--revoke-unmentioned=false`): one `<stem>.plan.json` next to each source — `planApplyRole` is called per source, no revokes emitted. Roles not declared in any source are left untouched on the modifier.
  - `--revoke-unmentioned=true` (directory mode only): one `<network>.<safe-address>.plan.json` per safe-dir — the SDK's `planApply` aggregates roles across siblings and natively revokes any role on the modifier not in the aggregated set. The basename is network-qualified so plans for the same Safe address on different chains stay distinct when flattened into one namespace (e.g. release assets).

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
bun run zac plan   <path>   # default: one <stem>.plan.json per source (no revokes)
bun run zac submit <path>   # posts every *.plan.json found under <path>, bundled per safe
```

Pass `--revoke-unmentioned=true` (directory mode only) to aggregate roles per safe-dir and emit revoke calls — one `<network>.<safe-address>.plan.json` per safe-dir, the SDK natively revokes any role on the modifier not in the aggregated set. The flag is a no-op in file-mode (one source → no aggregation to do); passing it explicitly with a single `*.zac.yaml` triggers a stderr WARN.

The proposer signs and submits the transaction proposal; other Safe owners then sign in the Safe UI. Optional env vars: `SAFE_API_KEY` (forwarded to api-kit if rate-limited). RPC is resolved per-chain via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`); `RPC_URL` is the universal fallback. The CLI `--rpc-url` flag overrides both. If neither is set for a chain in scope, the run errors out before contacting the chain.

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
