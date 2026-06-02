# ZAC Foundry fork tests

Hand-written Foundry tests that fork a real chain, stand up a fresh Safe + Roles
V2 Modifier, apply a rendered ZAC policy to them, then assert the Modifier's
allow/deny decisions.

Everything runs inside forge's own EVM. The Safe + Modifier are deployed through
the canonical CREATE2 factories on the fork, and the policy's role-state-update
calls are executed as the Safe via `vm.prank` — so any fork RPC works (no
anvil-specific cheats, no out-of-band transactions).

## How to run

```
just forge-test-fork https://your-upstream-rpc.example
```

That runs the `fork` profile (ZAC policy tests under `templates/**/tests/`) and
the `contracts-fork` profile (contract tests under `foundry/test/fork/`) against
the given RPC. Or directly:

```
cd foundry && FOUNDRY_PROFILE=fork RPC_URL=https://your-upstream-rpc.example forge test -vvv
```

If `RPC_URL` is unset, tests hard-fail at `vm.envString("RPC_URL")` in `setUp`.
That is intended: fork tests are opt-in via env, and missing env should error,
not silently skip.

## The harness (`ZacForkTest.sol`)

- `deployRolesFixture(SafeConfig cfg, address member)` — deploys a fresh Safe
  (owner = `member`, threshold 1) and a fresh Roles V2 Modifier
  (owner/avatar/target = the Safe) via `cfg`'s factories, enables the Modifier
  on the Safe, and enables `member` on the Modifier so it clears the Modifier's
  `moduleOnly` gate. Returns `RolesFixture { safe, modifier_ }`.
- `mainnetSafeConfig()` / `baseSafeConfig()` — per-chain `SafeConfig`s (the Safe
  + Zodiac factory/mastercopy addresses). They are CREATE2-deterministic, so a
  chain that ever diverges overrides just its own entry.
- `applyConfigFile(RolesFixture fx, address member, string fixtureRelPath)` —
  reads a policy fixture (see below), substitutes the runtime placeholders,
  renders + plans it via the ZAC CLI (`generate` then `plan` over FFI), and
  executes each planned role-state-update call in-process as the Safe (the
  Modifier's owner).

## Policy fixtures

Each test folder holds a `policy.zac.yaml` — a full deployment config with
placeholders for the values only known at runtime, which `applyConfigFile`
substitutes:

| Placeholder     | Replaced with                                  |
| --------------- | ---------------------------------------------- |
| `__MODIFIER__`  | the freshly deployed Roles Modifier            |
| `__SAFE__`      | the freshly deployed Safe                      |
| `__MEMBER__`    | the role member the test authorises            |
| `__TEMPLATES__` | the absolute `templates/` directory            |

## Adding a new fork test

1. Drop a `policy.zac.yaml` next to your test (see an existing one for the
   placeholder shape).
2. Write the test:

```solidity
import {ZacForkTest} from "zac-test/ZacForkTest.sol";

contract MyTest is ZacForkTest {
    address constant ALICE = 0x1111111111111111111111111111111111111111;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        RolesFixture memory fx = deployRolesFixture(mainnetSafeConfig(), ALICE);
        applyConfigFile(fx, ALICE, "my_template/tests/policy.zac.yaml");
        // assert allow/deny via fx.modifier_.execTransactionWithRole(...)
    }
}
```

## Caveats

- **`plan` needs the Zodiac subgraph.** `plan` computes the role-state-update
  calls by diffing against the subgraph, so the FFI step needs network access
  (the fork itself can be any RPC).
- **`out/` is shared with the default profile** (`out = "out"`). Switching
  `FOUNDRY_PROFILE` may force a recompile.
- **No CI workflow.** These tests need a live RPC; they are opt-in, local-only.
