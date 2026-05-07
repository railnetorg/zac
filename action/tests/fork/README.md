# Fork Integration Tests

End-to-end tests that exercise ZAC's apply pipeline against an anvil-forked
mainnet. Each test deploys a fresh Safe v1.4.1 + a fresh Zodiac Roles V2
modifier, applies a role using the real `planApplyRole` from
`zodiac-roles-sdk`, then drives `execTransactionWithRole` from a role member
to verify both happy paths and permission-violation reverts.

These tests are **opt-in and local-only** — no CI workflow is wired for them.
They require an upstream RPC (or the public fallback) and spawn an anvil
child process.

## Running

```sh
just action-test-fork
# or, equivalently:
cd action && bun run test:fork
```

The default unit suite (`just action-test`) excludes this directory, so it
stays hermetic and fast.

## Behaviour without an RPC

If `MAINNET_RPC_URL` is unset _and_ the public fallback (`https://eth.merkle.io`)
is unreachable, the suite skips gracefully with a logged reason. Skipped
tests count as passing under vitest, so this never breaks the build.

## Anvil

- Binary: `/Users/isma/.foundry/bin/anvil` (v1.5.1 confirmed).
- Port: `8546`.
- Fork block: `22500000` — pinned for reproducibility. Bump if upstream
  history is pruned away by your provider.
- Lifecycle: one anvil child per test file, started in `beforeAll`, killed
  in `afterAll`. Each test rolls back to a clean snapshot in `beforeEach`
  via `evm_revert`.

## Scenarios in `aave-v3.fork.test.ts`

The fixture (`fixtures/aave_usdc_only.yaml`) scopes a single role to
`USDC.approve(spender, amount)` with `spender == AAVE V3 pool`. We then
exercise:

| #   | Scenario                             | Expected outcome                                     |
| --- | ------------------------------------ | ---------------------------------------------------- |
| 1   | `USDC.approve(AAVE_pool, 1_000_000)` | success, allowance updated                           |
| 2   | `USDC.approve(0xATTACKER, 1)`        | revert `ConditionViolation(ParameterNotAllowed)`     |
| 3   | `DAI.approve(AAVE_pool, 1)`          | revert `ConditionViolation(TargetAddressNotAllowed)` |
| 4   | `USDC.transfer(0xATTACKER, 1)`       | revert `ConditionViolation(FunctionNotAllowed)`      |

Every step prints what it's doing — fork block, deployed addresses, the
fixture YAML, each scoping call decoded by selector, and the attempted
member calldata vs. the expected/actual outcome. Read top-to-bottom in CI
logs.

## Adding a scenario

1. Drop a new YAML under `fixtures/` (or extend an existing one).
2. Add an `it()` block in the `.fork.test.ts` describing the call to make
   via `execTransactionWithRole` and the expected status.
3. Use `decodeRolesRevert` from `applyOnFork.ts` to assert against the
   `Status` enum the modifier reverts with.

## Why not Safe TX Service?

Apply's posting layer (`/action/apply/safeApi.ts`) talks to Safe's hosted
transaction service to propose the multisig batch. On a fork that service
doesn't exist, and we don't need it: the fork test bypasses it by
executing each `planApplyRole` call directly as the Safe via
`execTransaction` with a pre-validated owner signature (`v=1` pattern, see
`setup.ts::execAsSafe`). Threshold-1 single-owner Safe makes this trivial.
