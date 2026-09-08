# Deploying a Lagoon vault under a Safe

`DeployLagoonVault.s.sol` creates the substrate one specialized vehicle needs: a Safe at your
own quorum, a Zodiac Roles V2 modifier for it, and a Lagoon vault curated by that Safe and
made permanently async-only.

It is a script rather than a checklist because the defaults are wrong. Deploying a Lagoon
vault through the obvious path gives a v0.5.0 vault with an open synchronous deposit path and
a mutable super-operator role — a vault Railnet's `ERC7540Vehicle` cannot legitimately wrap.

## Before you start

When this repository is a submodule of yours, its own Foundry libraries have to be present:
`forge script` compiles the whole project, not just the script, so a non-recursive submodule
checkout fails at compile time on `forge-std`, `safe-smart-account`, `aave-v3-origin`,
`morpho-blue` and `openzeppelin-contracts`.

```
git -C zac submodule update --init --recursive --depth 1
```

Around a minute and a few hundred megabytes, and only needed to run this script — managing
policies afterwards does not touch Foundry at all.

## Which chain

The Safe and Zodiac addresses the script uses are CREATE2-deterministic and identical on
every chain those deployments exist on. **Lagoon's factory and logic are not** — they are
per-chain, and the ones compiled in are Ethereum mainnet's. Deploying anywhere else means
updating `LAGOON_FACTORY` and `LAGOON_LOGIC_V0_6_0` from Lagoon's networks-and-addresses
page first. The script checks both have code before it uses them, so a wrong chain fails by
name rather than on an opaque revert.

## Parameters

`DEPLOYER` is the broadcasting key. It is the vault's admin for the duration of the run and
nothing after that, so it needs gas and nothing else.

| variable | required | changeable later |
| --- | --- | --- |
| `DEPLOYER` | yes | — |
| `SAFE_OWNERS`, `SAFE_THRESHOLD` | unless `SAFE_ADDRESS` | yes, through the Safe |
| `SAFE_ADDRESS` | no | reuse a Safe you made yourself |
| `VAULT_UNDERLYING` | yes | **no** |
| `VAULT_NAME`, `VAULT_SYMBOL` | yes | no |
| `VAULT_VALUATION_MANAGER` | yes | yes |
| `VAULT_ADMIN` | no, defaults to `DEPLOYER` | yes |
| `VAULT_WHITELIST_MANAGER` | no, defaults to `DEPLOYER` | yes |
| `VAULT_FEE_RECEIVER` | no, defaults to `DEPLOYER` | yes |
| `VAULT_SECURITY_COUNCIL` | no, defaults to unset | yes |
| `VAULT_PROXY_ADMIN_OWNER` | no, defaults to `DEPLOYER` | **not covered here** |
| `VAULT_UPGRADE_DELAY` | no, defaults to 86400 | **not covered here** |
| `VAULT_MANAGEMENT_RATE`, `VAULT_PERFORMANCE_RATE` | no, default 0 | yes |
| `DEPLOY_SALT` | yes in practice | see below |
| `DEPLOYMENT_KEY` | yes in practice | names the artifact; see below |

Anything marked changeable is `onlyOwner` on the vault, so a placeholder is a legitimate
answer — including `VAULT_VALUATION_MANAGER`, which the vault needs to settle but not to
exist. `VAULT_UPGRADE_DELAY` has a floor of 86400 seconds.

Two values are not configurable. The Lagoon logic is fixed at v0.6.0, because v0.5.0 has no
way to close its synchronous path. And `accessMode` is `Whitelist`, because in open mode any
third party can `requestRedeem` and `settleRedeem` pulls the assets from **your Safe** —
opening the vault would open a claim on the strategy's capital.

## Get these right the first time

**`VAULT_UNDERLYING`** is baked in at `__ERC4626_init`. If the vehicle will be registered on
a MultiVehicle, it also has to match that MultiVehicle's base asset, or registration is
rejected.

**The two locks the script applies** cannot be undone. `activateAsyncOnly()` makes the
synchronous entrypoints permanently unreachable, which is the property that lets an
`ERC7540Vehicle` wrap the vault at all. `lockSuperOperator()` freezes the super-operator role
at `address(0)`; left mutable, an admin could later grant an address that can `transferFrom`
any holder's shares without an allowance — on a wrapped vault, the vehicle's whole position.

**`VAULT_ADMIN` must not be the strategy Safe**, and the script refuses to run otherwise. The
admin can grant `securityCouncil`, which proposes NAVs that skip the guardrail check; what
bounds that is `settleDeposit` being `onlySafe` and reverting on a value mismatch, so a
falsified NAV needs two authorities. `updateSecurityCouncil` has no lock, so this stays a
property of your key layout — a governance Safe distinct from the strategy Safe, ideally
behind a timelock.

Do not set `VAULT_ADMIN` to `address(0)`. `onlyOwner` is what makes everything in the
changeable column changeable, so giving it up freezes all of it, `updateValuationManager`
included.

## Run

```
forge script script/DeployLagoonVault.s.sol:DeployLagoonVault \
  --rpc-url "$RPC_URL" --broadcast --account <keystore> --sender <deployer>
```

Import the key once with `cast wallet import <keystore> --interactive` rather than passing
`--private-key`, which puts it in your shell history.

Run it without `--broadcast` first. The simulation exercises the real factories against the
live chain, so a bad parameter fails before anything exists.

No `--verify`: the script creates no contracts. All five of its transactions are calls — three
factories and two `onlyOwner` setters — so Foundry has nothing to attribute to the script and
nothing to submit to a verifier. `--verify` also requires `--broadcast`, which makes it the
one flag you cannot rehearse: without `ETHERSCAN_API_KEY` it fails the run after the money is
spent. The three proxies are standard implementations behind well-known factories and are
already verified on-chain.

It prints the Safe, the modifier, the vault, `syncMode`, `isAsyncOnly`, the vault owner and
the pending admin nomination — then the two follow-ups below, with their calldata.

With `DEPLOYMENT_KEY` set it also writes `deployments/<network>/<key>.json`, holding those
three addresses, the salt, and the parameters that name an authority. That file is the input
to step 4 — hand it to the scaffold rather than copying addresses out of the log.

## Then, in this order

**1. `enableModule` on the Safe.** Needs the Safe's own quorum, which is why the script does
not do it. Through your normal signing flow, or via `approveHash`: each owner calls
`approveHash(safeTxHash)` independently, then anyone executes.

Independent of the policy, and easy to defer by mistake. Applying a role is a call from the
Safe *to* the modifier, so it succeeds whether or not the module is enabled — the whole
policy can be planned, proposed and executed, and every call routed through the modifier will
still revert `GS104` until this lands. A role that looks installed and does nothing is what
that gap produces.

**2. `acceptOwnership` on the vault**, as `VAULT_ADMIN`. The vault is `Ownable2Step`, so the
run only nominates; until this lands the authority stays with `DEPLOYER`.

**3. Whitelist the three addresses Railnet sends you** — the vehicle and its two queues — in
one `addToWhitelist` call, as `whitelistManager`. All three derive from `DEPLOY_SALT`, so we
can compute and send them before anything is deployed. All three have to be present:
`requestDeposit` checks `owner`, `controller` and `msg.sender`.

That makes the salt a commitment. Change it after this step and the three addresses change,
your whitelist entries go dead, and the spawn fails with `AddressNotAllowed` — which does not
say the salt moved. Record it and reuse it if anything has to be retried.

**4. Record the deployment, then write your policy configs.** The artifact from the run is
the record: it carries the salt, which no later read of the chain recovers. The scaffold
derives its alias files and its `config/<network>/<safe-address>/` directory from it, so the
Safe address is never retyped. Then one config per venue — the scaffold's README has the
layout. Whether Railnet reviews them before you apply is per-engagement; check what was
agreed.

## Verify

The script asserts these before it finishes, so a green run has checked them. They are what
everything downstream depends on, so they are worth reading off the vault yourself.

| read | expected | checked by |
| --- | --- | --- |
| `version()` | `"v0.6.0"` | the script |
| `isAsyncOnly()` | `true` | the script |
| `syncMode()` | `3` (`None`) | the script |
| `asset()` | your `VAULT_UNDERLYING` | the script |
| `safe()` | the deployed Safe | the script |
| `updateSuperOperator(…)` | reverts | the script |
| `setSyncMode(…)` | reverts | `DeployLagoonVaultFork.t.sol` |

The last two are checked by probing rather than by reading a value: `address(0)` looks
identical before and after a lock, and a closed sync mode looks identical to a reopenable one.

## If something fails

| symptom | cause |
| --- | --- |
| `DelayTooLow(86400)` | `VAULT_UPGRADE_DELAY` below the floor |
| `vault admin must not be the strategy Safe` | `VAULT_ADMIN` equals the Safe |
| `SAFE_THRESHOLD must be between 1 and the number of owners` | as it says |
| `vault did not deploy on the v0.6.0 logic` | the logic argument was not honoured — abandon the vault |
| `superOperator is still mutable after lockSuperOperator` | the lock did not take — abandon the vault |
| `AddressNotAllowed(<addr>)` at spawn | not whitelisted, or the salt changed |
| `EvmError: Revert` at low gas across a whole suite | the RPC rate-limited; not a logic failure |
| `GS104` on any call through the modifier | the module is not enabled on the Safe (follow-up 1) |
| `OnlySafe(<safe>)` from your own EOA | that setter is the Safe's to call, not the admin's |
| `plan` shows a change you already executed | the Zodiac indexer lags; check the modifier on-chain rather than re-executing |

The two "abandon the vault" rows are the only ones worth that: both concern one-way doors, and
the run stops before the vault can take a deposit, so nothing is at stake in starting over.
