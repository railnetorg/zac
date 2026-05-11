# ZAC Foundry fork tests

Hand-written Foundry tests that fork a real chain, apply a ZAC config to the
forked Safe + Roles modifier, then assert against the resulting on-fork state.

## Architecture

Three processes:

```
+-----------------+         +-----------------+         +-----------------+
|  upstream RPC   |         |  anvil (8546)   |         |  forge test     |
| (Alchemy, etc.) | <-----+ |  --fork-url     | <-----+ |  FOUNDRY_PROFILE|
|                 |         |  upstream       |         |  =fork          |
+-----------------+         +-----------------+         +-----------------+
                                    ^                          |
                                    |                          | vm.rpc(anvil_*)
                                    | eth_sendTransaction      | vm.tryFfi(bun ../action/cli.ts ...)
                                    +------------------------+ |
                                                               v
                                                       +-----------------+
                                                       | zac generate +  |
                                                       | zac plan        |
                                                       +-----------------+
```

- **upstream RPC**: the real chain (Sepolia / mainnet / etc.) — source of forked state.
- **anvil**: local fork. Both the FFI subprocess (zac CLI's read-only RPC queries) AND forge's in-process EVM talk to this same anvil URL, so state stays coherent.
- **forge**: runs the Solidity tests, calls the helper, then asserts.

## How to run

Convenience path — spawns anvil, exports `RPC_URL`, cleans up on exit:

```
just forge-test-fork https://your-upstream-rpc.example
```

Manual path — run anvil yourself, then run forge:

```
anvil --fork-url https://your-upstream-rpc.example --port 8546 &
cd foundry && FOUNDRY_PROFILE=fork RPC_URL=http://127.0.0.1:8546 forge test -vvv
```

`RPC_URL` must point at an anvil RPC, not a raw upstream, because the helper
uses `anvil_setBalance`, `anvil_impersonateAccount`, and
`anvil_stopImpersonatingAccount` — non-anvil nodes reject those methods.

If `RPC_URL` is unset, tests hard-fail at `vm.envString("RPC_URL")` in `setUp`.
That is the intended behavior: fork tests are opt-in via env, and missing env
should error, not silently skip.

## `zacApply(configPath)` semantics

The helper in `ZacForkTest.sol` does six things in order:

1. Read `RPC_URL` (hard-fail if unset).
2. Capture `startBlock = block.number`. This is forge's pinned block, BEFORE
   the helper mutates anvil.
3. **FFI**: `bun ../action/cli.ts generate <configPath> --out /tmp/...` —
   renders the YAML into a flattened deployment config. **Read-only.**
4. **FFI**: `bun ../action/cli.ts plan <generated> --out /tmp/....plan.json` —
   computes the role-state-update calls and emits a JSON artifact. **Read-only.**
5. **`vm.rpc`** loop: fund Safe (`anvil_setBalance`), impersonate it
   (`anvil_impersonateAccount`), then `eth_sendTransaction` each planned call
   from the Safe directly. Stop impersonation. **Each tx advances anvil's tip
   by 1 block (auto-mining).**
6. `vm.rollFork(startBlock + N)` — re-pin forge to anvil's new tip.

### Why `vm.rollFork`?

Forge's in-process EVM caches state at the block it was pinned to by
`vm.createSelectFork`. The `eth_sendTransaction` calls above advance anvil's
tip but do NOT auto-roll forge's pin. Without `vm.rollFork`, subsequent test
reads come from the cached pre-apply state and assertions fail.

FFI alone (`zac generate` / `zac plan`) is read-only — it does not move
anvil's tip and does not require any forge-side re-pinning. It is the
helper's `vm.rpc` calls that necessitate `vm.rollFork`.

### Why impersonate the Safe directly?

Modifier owner-only calls (`assignRoles`, `scopeTarget`, etc.) require
`msg.sender == safeAddress`. On a fork we can take the shortcut of
impersonating the Safe via `anvil_impersonateAccount` and sending the calls
directly, bypassing `Safe.execTransaction`'s threshold/signature checks. This
is the right shortcut for *configuring* the role.

Tests that need the real Safe → modifier → target path (e.g. exercising
`execTransactionWithRole` from a role member) still go through the on-chain
modifier and are NOT short-circuited.

## Caveats

- **Auto-mining must be on** (anvil default). If you run anvil with
  `--no-mining`, the `vm.rollFork(startBlock + N)` math is wrong because
  blocks won't auto-produce per tx. The helper does not defensively check.
- **Nonce drift**: between `zac plan` and the Safe TX Service `submit` step,
  the live Safe nonce may advance. Not relevant for fork tests (we never
  submit), but worth knowing if you use `zac plan` outputs elsewhere.
- **`out/` shared with default profile**: both profiles use `out = "out"`.
  Switching `FOUNDRY_PROFILE` may force a recompile if you've built under
  one and want to build under the other.
- **No CI workflow**: these tests need a live RPC and an anvil binary. They
  are opt-in local-only.

## Adding a new fork test

```solidity
import {ZacForkTest} from "./ZacForkTest.sol";

contract MyTest is ZacForkTest {
    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        zacApply("../examples/path/to/your_config.yaml");
    }

    function test_something() public {
        // assert against post-apply state
    }
}
```

`zacApply` is the only entry point — provide the config path relative to
`/foundry/` and you're done.
