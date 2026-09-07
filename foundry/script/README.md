# Deploying a Lagoon vault under a Safe

`DeployLagoonVault.s.sol` creates the substrate one specialized vehicle needs: a Safe at
your own quorum, a Zodiac Roles V2 modifier for it, and a Lagoon vault curated by that Safe
and made **permanently async-only**.

It exists because almost every value involved is wrong by default. Deploying a Lagoon vault
through the obvious path gives you a v0.5.0 vault with an open synchronous deposit path and a
mutable super-operator role — a vault Railnet's `ERC7540Vehicle` cannot legitimately wrap.
The script names each value explicitly and asserts the result.

## What it does not do

Two steps need an authority the script does not hold. It prints both, with calldata, at the
end of the run:

| step | authority |
| --- | --- |
| `enableModule` on the Safe | the Safe's own quorum |
| `acceptOwnership` on the vault | the nominated admin |

Spawning the `ERC7540Vehicle` over the vault is on the Railnet side — `spawn` is role-gated
in our factory — and so is registering it on the MultiVehicle.

## Before you run

Most of what this script writes is a parameter you can change afterwards. Three things are
not, and those are the ones to get right.

**Irreversible.** The Lagoon logic version, which the script fixes at v0.6.0, and the two
locks it then applies — `activateAsyncOnly()` and `lockSuperOperator()`. None can be undone
on a deployed vault.

**Effectively immutable.** `VAULT_UNDERLYING`, which is baked in at `__ERC4626_init`. It also
has to match the base asset of the MultiVehicle the vehicle will register on, or registration
is rejected.

**Set at proxy construction.** `VAULT_PROXY_ADMIN_OWNER` and `VAULT_UPGRADE_DELAY`. Changing
them afterwards is outside what this runbook covers, so treat them as decisions rather than
defaults. The delay floor is 86400 seconds; below it the ProxyAdmin rejects the deployment
with `DelayTooLow(86400)`.

**Everything else is `onlyOwner`-mutable** — `valuationManager`, `whitelistManager`,
`feeReceiver`, `securityCouncil`, `safe`, the fee rates, `accessMode`. A placeholder is a
legitimate answer for any of them, and the sections below say where one is actually a good
idea.

### The admin, which must not be the strategy Safe

The script refuses to run otherwise. The vault's `onlyOwner` authority can rotate every role,
including `securityCouncil` — and that role can propose a NAV that skips the guardrail check.
What bounds it is `settleDeposit` being `onlySafe` and reverting on a value mismatch, so a
falsified NAV needs the proposer **and** the Safe. That only holds while they are two
different entities. `updateSecurityCouncil` has no lock, so this is a property of your key
layout rather than something the deployment can close.

A governance Safe distinct from the strategy Safe is the shape to aim for, and a timelock in
front of it is the only lever left: it cannot remove the authority, only make its exercise
visible and delayed.

Both `updateSafe` and `transferOwnership` exist, so this is a property to keep rather than a
value to get right once. The script only guarantees the vault does not start out violating
it.

### Do not set the admin to `address(0)`

Mutable is not the same as disposable. `onlyOwner` is what makes every parameter in the last
group changeable, so giving it up freezes all of them: `updateValuationManager` above all — if
your provider migrates or rotates keys and you cannot repoint it, the vault becomes
permanently unsettleable — plus `updateSafe`, `updateWhitelistManager` (needed at every future
vehicle spawn), `pause()` and `initiateClosing()`.

### The NAV provider, and why a placeholder is fine here

Settlement is a two-step flow: the valuation manager proposes a NAV with
`updateNewTotalAssets(x)`, then the Safe confirms it with `settleDeposit(x)` /
`settleRedeem(x)` at the same value. The vault reverts on a mismatch, or when no proposal is
pending.

That makes a working valuation manager necessary to *operate* the vault, not to deploy it.
`updateValuationManager` is `onlyOwner`, so the real provider can land whenever it is ready.

Where it does become a gate is one step later: Railnet cannot `finalize()` the vehicle until
the spawn's initial deposit has settled, and settling it needs someone who can propose a NAV.
Two placeholders both work, for different reasons:

- **An address you control.** You settle the first epoch yourself, then hand the role over.
  This is often the better choice: the first `updateNewTotalAssets` skips the guardrail check
  (`lastFeeTime == 0`), and the initial NAV is a known quantity — the initial deposit — so no
  oracle is involved.
- **`address(0)`.** Fails closed. The check is a plain equality against the stored address and
  `msg.sender` is never zero, so nobody can propose a NAV until the admin sets a real one.
  Use this if you would rather the vault be unable to settle than settle under a temporary
  authority.

`VAULT_VALUATION_MANAGER` is required by the script even so. An unset valuation manager should
be a decision you typed, not a variable you forgot.

### And a funded key

The broadcasting EOA is the vault's admin for the duration of the run and nothing after
that.

## Parameters

| variable | required | notes |
| --- | --- | --- |
| `DEPLOYER` | yes | the broadcasting key; vault admin for the run only |
| `SAFE_OWNERS` | unless `SAFE_ADDRESS` | comma-separated |
| `SAFE_THRESHOLD` | unless `SAFE_ADDRESS` | your real quorum, not 1 |
| `SAFE_ADDRESS` | no | reuse a Safe you made yourself instead of deploying one |
| `VAULT_UNDERLYING` | yes | must match the MultiVehicle's base asset, or registration is rejected |
| `VAULT_NAME`, `VAULT_SYMBOL` | yes | the vault share token's |
| `VAULT_VALUATION_MANAGER` | yes | the NAV provider |
| `VAULT_ADMIN` | no | defaults to `DEPLOYER`; set it to the authority that should end up holding it |
| `VAULT_WHITELIST_MANAGER` | no | defaults to `DEPLOYER`; must be an address you control — every vehicle spawn needs it |
| `VAULT_FEE_RECEIVER` | no | defaults to `DEPLOYER` |
| `VAULT_SECURITY_COUNCIL` | no | defaults to unset, which is the recommendation |
| `VAULT_PROXY_ADMIN_OWNER` | no | defaults to `DEPLOYER` |
| `VAULT_UPGRADE_DELAY` | no | defaults to 86400, which is also the floor |
| `VAULT_MANAGEMENT_RATE`, `VAULT_PERFORMANCE_RATE` | no | basis points, default 0 |
| `DEPLOY_SALT` | yes in practice | see *The salt is a commitment* |

Two values are fixed by the script and not configurable: the Lagoon logic is v0.6.0, and
`accessMode` is `Whitelist`. The second is load-bearing — in open mode any third party can
`requestRedeem`, and `settleRedeem` pulls `convertToAssets(pendingShares)` from **your Safe**.
Opening the vault opens a claim on the strategy's capital.

## Run

```
forge script script/DeployLagoonVault.s.sol:DeployLagoonVault \
  --rpc-url "$MAINNET_RPC_URL" --broadcast --verify
```

Run it without `--broadcast` first. The simulation exercises the real factories against a fork
of current mainnet and fails on a bad parameter before anything exists.

The run ends by printing the Safe, the modifier, the vault, `syncMode`, `isAsyncOnly`, the
current vault owner and the pending nomination, then the two follow-ups with their calldata.

## Then, in this order

**1. `enableModule` on the Safe.** Through your normal signing flow, or via `approveHash`:
each owner calls `approveHash(safeTxHash)` on the Safe independently, then anyone executes
with pre-validated signatures. The second path avoids a coordinated signing session.

**2. `acceptOwnership` on the vault**, as `VAULT_ADMIN`. The vault is `Ownable2Step`, so the
run only nominates. Until this call lands the authority stays with `DEPLOYER`. That is the
safer default — a mistyped `VAULT_ADMIN` cannot strand the vault — but it is not a state to
leave sitting.

**3. Whitelist the three addresses Railnet sends you**, in one `addToWhitelist` call, as
`whitelistManager`. They are the vehicle and its two queues, and all three are derived from
the deployment salt, so we can compute and send them before anything is deployed.
`_requestDeposit` and `_requestRedeem` each check `owner`, `controller` and `msg.sender`, so
all three have to be present or the spawn's initial deposit reverts `AddressNotAllowed`.

**4. Write your policy configs**, one directory per Safe under
`config/<network>/<safe-address>/`. Railnet reviews them before you apply.

Three constraints that are easy to trip over. Railnet ships a reference config pair per
vehicle alongside the repo scaffold; until those land, read this section carefully — each one
fails in a way that does not name its own cause:

- **A distinct role key per template in a safe-dir.** Your venue policy and `lagoon.zac.yaml`
  both approve the same token, and under one role key that is a duplicate
  `(address, signature)` pair, which fails `generate` with a message naming the *function*
  rather than the collision.
- **`safe.yaml` with `fallback: 0x0` set explicitly.** Not cosmetic. Morpho fires a callback
  on the Safe whenever `data` is non-empty, including after a `repay` has reduced the debt and
  before the Safe has paid. With no fallback handler installed, Safe answers that callback with
  `return(0, 0)` and it is a silent no-op. Installing a handler puts code in that window.
- **Every config for a safe-dir travels together.** The workflows run with
  `--revoke-unmentioned=true`, so the directory is the whole truth: commit the venue policy
  without `lagoon.zac.yaml` and the plan revokes the settlement role.

## The salt is a commitment

The vehicle and queue addresses derive from `DEPLOY_SALT` alone. Once you have whitelisted
them, changing the salt changes all three, your whitelist entries go dead, and the spawn fails
with `AddressNotAllowed` — which does not say "the salt changed". Record the salt in the repo
alongside the deployment and reuse it if anything has to be retried.

## Verify

These are the properties everything downstream depends on, so they are worth reading off the
vault yourself even though the run has already checked most of them:

| read | expected | checked by |
| --- | --- | --- |
| `version()` | `"v0.6.0"` | the script |
| `isAsyncOnly()` | `true` | the script |
| `syncMode()` | `3` (`None`) | the script |
| `asset()` | your `VAULT_UNDERLYING` | the script |
| `safe()` | the deployed Safe | the script |
| `updateSuperOperator(...)` | reverts — the role is locked at `address(0)` | the script |
| `setSyncMode(...)` | reverts — async-only cannot be undone | `DeployLagoonVaultFork.t.sol` |

The last two are the point of the exercise. `superOperator` can `transferFrom` on any holder
with the allowance check skipped, bypass the allowlist on transfers, and act as operator for
any controller; on a vault wrapped by a vehicle that is the vehicle's entire position. Setting
it to zero disables it, but only `lockSuperOperator()` makes the zero permanent. Likewise
`setSyncMode(None)` closes the sync path but is reversible by the Safe's owners at any time,
which is why the script uses `activateAsyncOnly()` instead — it is irreversible and sets the
mode itself.

`activateAsyncOnly()` runs before the first `addToWhitelist`, which is a tighter precondition
than "before the first deposit" and an enforceable one: in `Whitelist` mode nobody can deposit
until an address is whitelisted, so the ordering is between two transactions rather than
something to stay watchful about.

## If something fails

| symptom | cause |
| --- | --- |
| `DelayTooLow(86400)` | `VAULT_UPGRADE_DELAY` below the ProxyAdmin floor |
| `vault admin must not be the strategy Safe` | `VAULT_ADMIN` equals the Safe |
| `vault did not deploy on the v0.6.0 logic` | the logic argument was not honoured; do not proceed |
| `superOperator is still mutable after lockSuperOperator` | the lock did not take; do not proceed |
| `AddressNotAllowed(<addr>)` at spawn | that address is not whitelisted, or the salt changed |
| `EvmError: Revert` at tiny gas across a whole suite | the RPC rate-limited; not a logic failure |

The first four leave nothing behind worth worrying about, and a vault that fails the last two
assertions is one to abandon rather than repair — both are one-way doors and the run stops
before the vault can take a deposit.
