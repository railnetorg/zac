# zac

Zodiac Roles V2 config generator (CLI) plus the Foundry contracts that back it.

ZAC v2 is a Bun + TypeScript CLI named `zac`. Five subcommands: `generate`, `plan`, `apply`, `submit`, `schedule`. The generate pipeline is load → render → parse → validate → emit, fail-fast; plan/apply/submit drive the Safe Transaction Service round-trip; `schedule` drives the optional TimelockGuard install + per-proposal scheduling flow.

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
  - `--revoke-unmentioned=true` (directory mode only): one `<safe-address>.plan.json` per safe-dir — the SDK's `planApply` aggregates roles across siblings and natively revokes any role on the modifier not in the aggregated set.

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

Pass `--revoke-unmentioned=true` (directory mode only) to aggregate roles per safe-dir and emit revoke calls — one `<safe-address>.plan.json` per safe-dir, the SDK natively revokes any role on the modifier not in the aggregated set. The flag is a no-op in file-mode (one source → no aggregation to do); passing it explicitly with a single `*.zac.yaml` triggers a stderr WARN.

The proposer signs and submits the transaction proposal; other Safe owners then sign in the Safe UI. Optional env vars: `SAFE_API_KEY` (forwarded to api-kit if rate-limited). RPC is resolved per-chain via `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`, `BASE_RPC_URL`); `RPC_URL` is the universal fallback. The CLI `--rpc-url` flag overrides both. If neither is set for a chain in scope, the run errors out before contacting the chain.

## Schedule (optional — TimelockGuard)

ZAC ships a `TimelockGuardOnly` contract (`foundry/src/guards/TimeLock.guard.sol`) that enforces a delay between when owners sign a Safe transaction and when it can be executed. During the delay, anyone can permissionlessly cancel a pending transaction. Full lifecycle: see `foundry/src/guards/README.md`.

**Install + configure**. Deploy the singleton once per network:

```
cd foundry && forge script script/DeployTimelockGuardOnly.s.sol --rpc-url $RPC_URL --broadcast --private-key $PK
```

Then per-Safe, set the nested-object guard form in `safe.yaml`:

```yaml
guard:
  address: 0xTimelockGuardOnly...
  timelock_delay: 86400        # delay in seconds; 0 < delay <= 365 days
fallback: ~
modules: ~
```

Run `zac apply` — `planSafeConfig` batches `setGuard` and `configureTimelockGuard(delay)` into a single MultiSend so the guard is never enabled with `delay = 0`. Idempotent: re-running with the same delay produces no Safe tx; changing the delay produces just the `configureTimelockGuard` call.

**Schedule signed proposals**. Once owners reach quorum on a proposal (via `zac apply` or the Safe UI), the `Pending` state on the guard starts via `scheduleTransaction`. ZAC handles that:

```
export ZAC_SCHEDULER_PRIVATE_KEY=0x...   # any funded EOA — does NOT need to be a Safe owner
bun run zac schedule <path>              # safe.yaml file or directory (walked recursively)
```

`schedule` fetches pending proposals from Safe Transaction Service, filters to those that have reached the Safe's confirmation threshold AND aren't already scheduled on-chain, sorts signatures in ascending owner-address order, and broadcasts `scheduleTransaction` for each. Output is one `scheduled` / `skipped` / `nothing` line per safe-dir. After `executionTime` is reached, owners execute through the normal Safe flow.

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
