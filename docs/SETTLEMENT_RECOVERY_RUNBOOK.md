# Settlement recovery runbook — "allocating" stuck state

Applies to: `app/api/games/mpgr-run/settlement/route.ts` and
`app/api/games/mpgr-run/settlement/reconcile/route.ts`.

## Why this exists

Weekly settlement moves a `WeeklySettlement` through
`closed -> computed -> allocating -> finalized` (or `aborted`). The
`allocating -> finalized` step includes one on-chain write
(`allocateRewardsBatch`). If the process crashes or the platform kills
the function between broadcasting that transaction and persisting its
result, the settlement is left in `allocating` with an unknown
real-world outcome: the batch may have landed on-chain, or it may not
have.

The system **deliberately does not auto-retry** a settlement stuck in
`allocating` — see the "Known limitation" comment at the bottom of
`settlement/route.ts`. Auto-retrying risks calling
`allocateRewardsBatch` a second time for the same week, which the vault
contract has no idempotency key to prevent, and that is strictly worse
than a paused settlement. Recovery is therefore a manual step.

## How you'll find out

The daily reconcile cron (`/api/games/mpgr-run/settlement/reconcile`,
`vercel.json`, 06:15 UTC) calls `reconcileSettlement()` for the most
recent week. If a settlement has been in `allocating` for longer than
`SETTLEMENT_STUCK_THRESHOLD_MS` (default 2 hours, env-configurable),
the response includes `"alert": true` and the server log emits a single
line starting with `SETTLEMENT_STUCK_ALLOCATING` — point your log-based
alerting (Vercel log drain, Sentry, Datadog, etc.) at that string.

This detects and surfaces the condition. It does not fix it — that's
the rest of this document.

## Recovery steps

1. **Identify the week.** Note the `weekKey` from the alert (e.g.
   `2026-W36`).

2. **Pull the expected state.** For each payable player in that week,
   get `PlayerWeekRecord.allocatedAmountRaw` and `wallet` from the KV
   store (`kv-allocation-store.ts` / `listEligiblePlayersForWeek`).
   This is what *should* have been allocated.

3. **Check the real on-chain state.** For each of those wallets, call
   the vault's `getUserRewardIds(wallet)` (view function, `reward-vault-
   admin-abi.ts`) and `getReward(rewardId)` for each id returned. Look
   for a reward matching this week's `seasonId`, the expected `amount`,
   and `rewardType == 0` (GAME). This is exactly what
   `reconcileSettlement()` already automates — you can just call
   `GET /api/games/mpgr-run/settlement/reconcile?week=<weekKey>` again
   and read `confirmed` vs `expected` in the response instead of doing
   this by hand.

4. **Decide based on what you find:**

   - **`confirmed === expected` (all rewards found on-chain):**
     nothing to do — `reconcileSettlement()` will finalize the
     settlement itself on this call. Re-run the reconcile endpoint if
     you haven't already; you don't need to touch KV directly.

   - **`confirmed === 0` and no `RewardAllocated` events at all for
     this week's `seasonId`** (checked via
     `findRewardAllocationTxHash` / the vault's event logs): the
     transaction never landed. It is safe to reset the settlement back
     to `computed` so the next scheduled/manual run of
     `/api/games/mpgr-run/settlement` re-attempts the allocation:
     ```
     kvAllocationStore.upsertWeeklySettlement(
       { ...settlement, status: "computed", allocationAttemptId: null, updatedAt: new Date().toISOString() },
       "allocating"
     )
     ```
     Run this from a one-off authenticated script/console, not by
     adding a new public endpoint. Then re-trigger settlement.

   - **`0 < confirmed < expected`** (partial): this should not happen
     for a single `allocateRewardsBatch` call, since one EVM
     transaction either fully succeeds or fully reverts — treat this
     as unexpected and stop. Do not reset to `computed` (that risks a
     second, overlapping batch for the players who are already paid).
     Escalate for manual, per-wallet reconciliation instead.

5. **After manually resetting or finalizing**, confirm the fix by
   calling the reconcile endpoint once more and checking the response
   no longer has `"alert": true`.

## What NOT to do

- Do not add automatic retry logic for an `allocating` settlement.
- Do not call `allocateRewardsBatch` directly against a week that has
  *any* confirmed rewards already, without first confirming exactly
  which wallets are missing.
- Do not reset a settlement to `computed` without first confirming
  (via reconcile or the vault's event logs) that zero rewards from that
  batch exist on-chain.
