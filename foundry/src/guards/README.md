# TimelockGuardOnly — Transaction lifecycle

`TimelockGuardOnly` is a singleton Safe guard (deployed once per network) that any Safe v1.4.1 can install to enforce a configurable delay between when a transaction is signed and when it can be executed. During the delay window, anyone can cancel a pending transaction permissionlessly — the cost of an attempted malicious execution is that an honest party can stop it.

The guard tracks transactions through four states:

```
        scheduleTransaction()                 execTransaction()
NotScheduled ───────────────► Pending ───────────────────────► Executed
                                 │
                                 │  cancelTransaction()
                                 ▼
                              Cancelled
```

This doc walks one transaction from proposal to execution, and shows where each ZAC subcommand fits.

## 0. Setup (one-time)

The guard is installed atomically — `setGuard` and `configureTimelockGuard(delay)` MUST be batched in a single Safe transaction. Skipping the batch leaves a window where the guard is enabled with `delay = 0`, defeating the purpose.

ZAC handles this via `safe.yaml`:

```yaml
guard:
  address: 0xTimelockGuardOnly...   # deployed via DeployTimelockGuardOnly.s.sol
  timelock_delay: 86400             # 1 day, in seconds
fallback: ~
modules: ~
```

When `zac apply` sees this, `planSafeConfig` emits both calls in the same MultiSend payload:

1. `Safe.setGuard(<guard>)`
2. `<guard>.configureTimelockGuard(<delay>)`

Both run from the Safe's context (via DelegateCall to MultiSendCallOnly), so the guard contract sees `msg.sender == Safe` and writes the delay into its per-Safe state.

Constraints enforced by the contract:
- The Safe MUST be version 1.4.1 (reverts otherwise).
- `delay` MUST be in `(0, 365 days]` (`InvalidTimelockDelay` revert outside that range).

After this transaction lands, the Safe is in the "guard installed and configured" state. `cancellationThreshold(safe)` is initialized to 1.

## 1. Proposal — owner builds and signs

A Safe owner proposes a transaction the usual way (Safe UI, safe-cli, `zac apply` of role updates, etc.). The proposal goes into Safe Transaction Service like any other — at this point the guard isn't involved.

The proposal accumulates confirmations from other owners. The guard does NOT change this part of the Safe flow; the same threshold-of-owners signing applies.

State so far: `NotScheduled` (the guard has no record yet).

## 2. Schedule — `scheduleTransaction`

Once the proposal reaches the Safe's confirmation threshold, ANY address (not just an owner) can call `guard.scheduleTransaction(safe, nonce, params, signatures)`. The guard:

1. Re-checks the Safe's signatures (`checkSignatures` — same logic as `execTransaction`). Signatures must be concatenated in **ascending owner-address order**.
2. Confirms the guard is enabled on the Safe (storage slot check) and configured with a non-zero delay.
3. Records `executionTime = block.timestamp + timelockDelay`.
4. Marks the tx `Pending` and adds it to the pending set.

If `executionTime` is already non-zero for this tx hash, the call reverts (`TransactionAlreadyScheduled`) — a tx can be scheduled exactly once, regardless of whether it's later cancelled. This prevents replay of gathered signatures.

**ZAC mapping**: `zac schedule <path>` polls the Safe Transaction Service for proposals at this Safe that have quorum, then broadcasts `scheduleTransaction` for any not yet scheduled on-chain. The broadcaster pays gas via `ZAC_SCHEDULER_PRIVATE_KEY` (a separate, low-privilege key — it doesn't need to be a Safe owner). Signature ordering is handled inside `runSchedule`.

State transition: `NotScheduled → Pending`.

## 3. Wait — `Pending`

Between schedule and execution, the transaction sits in `Pending` for `timelockDelay` seconds. During this window:

- `pendingTransactions(safe)` returns the queue (useful for monitoring).
- `scheduledTransaction(safe, txHash)` exposes `executionTime` and full params.
- Anyone with sufficient signatures may cancel (see step 4).

The Safe itself does NOT advance during this window. The Safe's nonce is unchanged; `execTransaction` would still operate on the same nonce when the time comes.

## 4. (Optional) Cancel — `cancelTransaction`

`cancelTransaction(safe, txHash, nonce, signatures)` can be called by anyone presenting `cancellationThreshold` valid owner signatures over a "cancellation message" specific to the Safe / nonce / tx hash. Each cancellation:

1. Marks the tx `Cancelled` and removes it from the pending set.
2. Increases the `cancellationThreshold` for this Safe by 1 (capped at `maxCancellationThreshold(safe)`, derived from the Safe's quorum and blocking threshold — see contract comments).

The escalating threshold prevents griefing: each cancellation costs incrementally more coordination, while still letting honest owners stop a malicious transaction even if attackers control a quorum of keys.

The threshold resets to 1 after the next successful execution (step 5).

Cancellation is allowed even after the guard has been disabled — `clearTimelockGuard` is the way to permanently uninstall after disabling. Cancellation just drains the queue.

State transition: `Pending → Cancelled` (terminal — that exact tx-hash can never schedule again).

## 5. Execute — `execTransaction` (Safe-side)

After `executionTime <= block.timestamp` (and assuming not cancelled), an owner calls `Safe.execTransaction(...)` the normal way. The guard hooks `checkTransaction` and verifies:

- The tx hash matches a `Pending` scheduled entry.
- `block.timestamp >= executionTime`.
- The tx hasn't already been executed or cancelled.

If any check fails, the guard reverts before the Safe runs the call. On success, the Safe executes; afterwards `checkAfterExecution` marks the entry `Executed` and resets `cancellationThreshold` to 1.

State transition: `Pending → Executed` (terminal).

## Quick reference: who can do what

| Action                   | Caller                                                       | Auth                                                    |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------------- |
| `configureTimelockGuard` | The Safe itself (via `execTransaction` delegatecalling here) | `msg.sender == Safe`, Safe is v1.4.1, guard is enabled  |
| `scheduleTransaction`    | Anyone                                                       | Valid Safe signatures meeting the Safe's quorum         |
| `cancelTransaction`      | Anyone                                                       | Valid owner signatures meeting `cancellationThreshold`  |
| `execTransaction`        | Safe owners                                                  | Same as a normal Safe execution, plus guard's `checkTransaction` |
| `clearTimelockGuard`     | The Safe itself                                              | Guard must already be DISABLED on the Safe              |

## ZAC end-to-end

| Lifecycle phase  | ZAC operation                                                |
| ---------------- | ------------------------------------------------------------ |
| Deploy guard     | `forge script script/DeployTimelockGuardOnly.s.sol --broadcast` |
| Install + configure | `zac apply <safe-dir>` with `safe.yaml` setting `guard.timelock_delay` |
| Propose          | Whatever the Safe owners use today (`zac apply` for role updates, Safe UI, etc.) |
| Schedule         | `zac schedule <safe-dir>` (uses `ZAC_SCHEDULER_PRIVATE_KEY`) |
| Cancel           | Manual — not yet exposed via ZAC                             |
| Execute          | Safe UI / safe-cli once `executionTime` is reached           |

## Operational gotchas

- **Signature ordering** — the guard reverts on out-of-order sig concatenation. ZAC's `runSchedule` sorts before broadcasting; manual callers must too.
- **One-shot schedule per tx hash** — replays of the same signed payload are rejected, even after cancellation. Owners must re-sign at a new nonce to retry.
- **Per-Safe state** — every config field (`timelockDelay`, `cancellationThreshold`, pending set) is keyed by Safe address. Multiple Safes share the same deployed guard without interfering.
- **Re-configuration is allowed** — calling `configureTimelockGuard` again from the Safe overwrites the delay. This must be batched the same way as initial install if you want to change while the guard is enabled.
- **Clearing** — to uninstall: `Safe.setGuard(address(0))` then `guard.clearTimelockGuard()`. Cancels any still-pending entries.
