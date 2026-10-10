# Daily Spend Reservations & the CSV→Hash Migration Fence

**Scope:** `lib/autonomy/day-ledger-scripts.ts`, `lib/autonomy/store.ts`,
`lib/autonomy/redis-store.ts`, `lib/autonomy/runtime.ts`, `lib/autonomy/types.ts`.
**Status:** code + tests complete; production cutover is an operator procedure
(see §5) — live production verification is **NOT VERIFIED** from this repository.

This document covers the two security properties added to the autonomous
runtime's policy-day ledger:

1. **Atomic daily spend-cap enforcement (R3)** — `maxDaily` and
   `maxActionsPerDay` are enforced inside one atomic Redis script per
   reservation, for ALL goals sharing a policy, with exact integer arithmetic.
2. **CSV→hash migration fence (R4)** — the legacy CSV ledger is imported and
   fenced in ONE atomic Lua operation, fail-closed on malformed data, with old
   writers fenced out and no path that resets an existing total to zero.

Plus the **reservation lifecycle (R5)** that decides, for every execution
outcome, whether the day's spend stays counted (conservative) or is freed
(only for verified pre-broadcast refusals).

---

## 1. The bug being fixed

The pre-fix ledger (`mpgrhub:autonomy:day:{policyId}:{day}`) was an
append-capped **CSV of base-unit digit strings**:

* the Lua append (`tryRecordDailyAction`) atomically enforced only the
  **action COUNT** cap;
* the **spend SUM** (`maxDaily`) was checked in TypeScript *before* the append
  (`getDailySpendRaw` + `evaluatePolicyAgainstAction`) — a classic
  read-then-write race.

Two goals sharing one policy could both pass the spend pre-check against the
same empty day and jointly spend up to **2× `maxDaily`** (N goals → N×). The
per-goal evaluation lease does not help: the lease is per goal, and the cap is
per policy. A per-goal lock or TTL lease is **not** the spend-cap protection;
the atomic reservation script is.

The unsafe API (`tryRecordDailyAction`, `addDailySpendRaw`, `addDailyAction`)
has been **removed**. There is no remaining code path that can append to a
daily ledger without the atomic caps.

---

## 2. The reservation ledger and lifecycle (R3/R5)

### 2.1 Keys (one policy, one UTC day)

| Key | Content |
| --- | --- |
| `mpgrhub:autonomy:day:{policyId}:{day}` | **legacy CSV** (pre-fix). After migration it holds the fence **poison** (§3) |
| `mpgrhub:autonomy:dayv2:{policyId}:{day}` | **authoritative hash**: `total`, `count`, `migrated`, `legacy`, `legacyCount`, and one `res:{execId}` field per reservation |
| `mpgrhub:autonomy:dayfence:{policyId}:{day}` | fence marker ("1") — separate key so "fenced but hash lost" is distinguishable from "never migrated" |
| `mpgrhub:autonomy:dayarchive:{policyId}:{day}` | exact copy of the legacy CSV at migration time (operator recovery source) |

`total`/`count` include every reservation in state RESERVED, ATTEMPTING,
COMMITTED or AMBIGUOUS. RELEASED entries are subtracted again. The day hash is
the ONLY source of truth after migration; the pre-check in the runtime is a
fast path — the reservation script re-checks both caps atomically and is
authoritative.

### 2.2 State machine (per execution id)

```
                 reserve (atomic cap check)
                        │
                        ▼
                    RESERVED ──────────────► RELEASED   (reason: UNATTEMPTED
                        │                            — crash recovery only)
          markSpendAttempt (persisted BEFORE
          the execution adapter is invoked)
                        │
                        ▼
                   ATTEMPTING ────────────► RELEASED   (reason:
                        │                    PRE_BROADCAST_REFUSAL — only for
                        │                    explicit verified codes, see §2.3)
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
      COMMITTED     AMBIGUOUS     (stay ATTEMPTING —
   (successful or   (unknown:      recovery is manual,
    reverted tx;     throw, RPC_ERROR,  §6)
    spend STAYS)     timeout, crash)
                     spend STAYS)
```

The attempt marker (`markSpendAttempt`, R→A) is persisted **before**
`adapter.executeSwap` is called. Once A is visible, a crash may have broadcast;
the reservation is then **never released automatically**.

### 2.3 Failure classification — commit / release / ambiguous

| Outcome | Reservation | Why |
| --- | --- | --- |
| Successful execution (tx submitted) | **COMMITTED** at submit | spend stays counted even if the receipt later reverts |
| Reverted execution | **COMMITTED** (unchanged) | gas was spent; over-counting is safe |
| Clean adapter/guard refusal with a code in `PRE_BROADCAST_REFUSAL_CODES` | **RELEASED** | the producer contract of these codes is "nothing was broadcast" |
| Quote-stale guard, goal-state CAS lost (raced by pause/cancel) | **RELEASED** (QUOTE_STALE / UNATTEMPTED) | provably pre-attempt |
| Unknown error / thrown adapter error | **AMBIGUOUS** | the broadcast may have happened |
| `RPC_ERROR`, `TIMEOUT` from the adapter | **AMBIGUOUS** | "Delegated broadcast failed" does not prove non-broadcast |
| Verification verdict UNCERTAIN / timeout budget exhausted | stays **COMMITTED** (released at submit) | conservative |
| Duplicate retry with the same execution id | **no state change** | idempotent: never double-counted, adapter never re-invoked |
| Redis failure before/at reserve | fail closed — no broadcast | a later retry with the same id is idempotent |
| Lost Redis response at markSpendAttempt | fail closed — adapter NOT invoked; stays RESERVED (recoverable as UNATTEMPTED) | the marker may or may not have landed; if it landed the UNATTEMPTED release is refused |
| Process crash after the attempt marker | stays ATTEMPTING → operator marks AMBIGUOUS | never auto-released |
| Uncertain transaction outcome | **AMBIGUOUS** | spend stays counted |

`PRE_BROADCAST_REFUSAL_CODES` (types.ts) is the ONLY set of codes that may free
spend: `POLICY_REJECTED`, `AUTHORIZATION_MISSING`, `APPROVAL_REQUIRED`,
`USER_REJECTED`, `TOKEN_NOT_ALLOWED`, `QUOTE_STALE`, `INVALID_CONDITION`,
`MCP_DISABLED`, `EXECUTOR_PAUSED`, `EXECUTION_UNAVAILABLE`. The store itself
re-validates membership (defense in depth) and the release script enforces the
state machine (U only from R; P only from R/A).

**Adapter contract invariant:** a clean `ok:false` result carrying one of these
codes MUST be produced strictly before any broadcast attempt. The current
adapters already obey this (their refusal messages say "Nothing was
broadcast/sent"); a future adapter that returns e.g. `EXECUTION_UNAVAILABLE`
after a broadcast attempt would break the release guarantee.

### 2.4 Exact arithmetic

Raw token amounts are decimal strings that exceed both float64 precision and
Lua's integer ranges (an 18-decimal token's `10 000` human units is `1e22`).
The Lua scripts sum/compare/subtract amounts as **digit strings**
(schoolbook arithmetic in `day-ledger-scripts.ts`); TypeScript keeps them as
strings/BigInt. No amount ever passes through a floating-point number.

### 2.5 Infrastructure outages vs trade failures

`MCP_DISABLED` (switch/MCP off), `EXECUTOR_PAUSED` and `RPC_ERROR` are
classified `INFRASTRUCTURE_OUTAGE_CODES`: they never increment
`stats.consecutiveFailures` and never flip a goal to FAILED. A switched-off or
RPC-broken deployment therefore does not burn down active goals; they keep
observing until recovery. All other failure codes behave exactly as before.

---

## 3. The CSV→hash migration fence (R4)

`ensure_day_ledger()` (in every reserve/read/restore script, one canonical
source) performs the migration **in one atomic Lua operation**:

1. If the fence exists (or the legacy key already holds the poison): return the
   hash totals; if the hash is missing/corrupt → `LEDGER_UNAVAILABLE`
   (**never** a fresh zeroed ledger).
2. Otherwise: read the legacy CSV and **validate every field first**
   (`^%d+$` strictly — empty fields `1,,2`, trailing commas and non-digit junk
   are malformed). Redis Lua runtime errors do NOT roll back earlier writes, so
   validation completes before ANY write. Malformed data → `MALFORMED_LEGACY`
   with **zero writes** (no partial migration, no poison, no reset).
3. Only then write, atomically: the hash (`total`/`count` = imported sum, plus
   a `legacy`/`legacyCount` forensics copy), the archive (raw CSV), the fence
   key, and the **poison** into the legacy key.

### 3.1 How old writers are fenced out

The poisoned legacy key holds 1000 `__FENCED__` fields (non-digit, far more
than any legal `maxActionsPerDay`, which policy normalization caps at 50).
The frozen old append script counts fields with `[^,]+` and refuses once
`n + 1 > cap` — so **every** legal cap is refused after the fence. The old
TypeScript reader also drops the non-digit fields and the old action-count
pre-check refuses. Old CSV writers therefore cannot admit actions after the
fence, and the poison can never be mistaken for migrated amounts (the strict
parser would reject it; the exact-poison marker check runs first).

### 3.2 Ordering guarantees (lost writes are impossible)

The old append and the migration script are each single Redis operations, so
they serialize: an old write either lands **before** the fence (and is
imported into `total`) or is **refused by the poison**. A new-code reservation
and an old-code append can never jointly exceed the cap: the migration+reserve
is one atomic script whose cap check includes every pre-fence CSV entry.

### 3.3 Explicitly required edge cases

| Case | Behavior | Test |
| --- | --- | --- |
| legacy CSV present | imported once, fenced, archived | `legacy-ledger-migration.test.ts` |
| legacy CSV absent (fresh day) | fenced zero ledger; old writer cannot start a new CSV | same |
| malformed legacy (incl. empty fields) | `MALFORMED_LEGACY`, zero writes, data preserved for repair | same |
| already fenced (migration retry) | idempotent — totals never double-imported | same |
| old writer after fencing | refused at every legal cap | same |
| stale legacy write after fencing | ignored (fence authoritative) | same |
| concurrent old/new writers | import-or-refuse; cap holds; no lost write | same + real-redis suite |
| missing hash behind an existing fence | `LEDGER_UNAVAILABLE` (**not** zero); `restoreDayLedger` rebuilds from archive | same |
| legacy key missing but hash exists | hash totals preserved (never reset) | same |
| exact large integers (beyond 2^53 and 2^63) | exact string arithmetic | both suites |

---

## 4. What is proven here vs what is NOT

* **Proven (tests):** the fence mechanism stops frozen old-code writers
  atomically; concurrent old/new writes serialize correctly (import-or-refuse);
  every malformed/missing edge fails closed; the caps hold under true
  concurrency across two real Redis connections (`daily-spend.redis.test.ts`).
* **Proven (tests):** the reservation lifecycle release rules, attempt-marker
  ordering, duplicate-id idempotency, crash windows, and one-broadcast safety
  (`daily-spend-reservations.test.ts`, `reservation-lifecycle.runtime.test.ts`).
* **NOT VERIFIED (hard prerequisite for cutover):** the live rolling-deploy
  drain in the production Upstash instance. The cross-version accounting is
  safe by construction (§3.2), but during the rollout window **two old
  instances** can still race each other with the pre-fix TOCTOU (the very bug
  being fixed). The drain procedure in §5 eliminates that window. Until an
  operator executes §5 against production, the migration must NOT be claimed
  safe in production.
* **NOT VERIFIED:** production environment variables / KV (untouched by this
  work; `AUTONOMOUS_PRODUCTION_ENABLED` remains OFF and was not modified).

---

## 5. Deployment / rolling-deploy sequence (operator runbook)

The new code fences lazily and atomically at the first ledger access per
policy-day, so no separate migration job is required. The drain exists to
close the legacy↔legacy race during the rollout and to make cutover
verifiable:

1. **Drain old writers.** Set `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` in the
   deployment environment (this flag exists in BOTH old and new code and gates
   every evaluation). Wait ≥ 2 minutes (`evaluationLeaseSeconds` is 120 s) so
   in-flight evaluations finish and every instance is quiescent. From this
   moment no instance (old or new) admits any autonomous action.
2. **Deploy the new code** (normal platform rollout). Old instances cannot
   write; new code fences on first ledger access.
3. **Midnight note.** The fence is per policy-UTC-day. If the drain/deploy
   window could cross 00:00 UTC with old instances still alive, keep the
   emergency disable ON until the deploy has fully replaced them — the drain,
   not the fence, is what stops a straggling old instance from writing into
   the next day's (not-yet-fenced) CSV. New-code first access then imports any
   such pre-fence write (§3.2 — it is never lost).
4. **Verify** (read-only): tick/evaluate a canary policy on Base Sepolia, or
   inspect `mpgrhub:autonomy:dayv2:*` hashes exist and `day:*` keys hold the
   poison for active policy-days. Confirm `AUTONOMOUS_PRODUCTION_ENABLED` is
   unchanged and the production gate state is as intended (this work does not
   touch it).
5. **Re-enable** (`MPGR_AUTONOMOUS_EMERGENCY_DISABLE=false`).

**Rollback:** deploy the previous release and set
`MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` first (so no writer races during the
roll-back). The old code reads the legacy CSV key — which now contains the
poison — and fails **closed** (spend pre-check huge/OVER_ACTION_RATE; the old
append is refused), so a rollback cannot overspend; it simply parks goals
until the operator restores a readable ledger. If goals must run on the old
code after rollback, an operator can `DEL` the poisoned `day:*` key and restore
its archived CSV content from `dayarchive:*` (read-only amounts, digit
strings). Reservations recorded in `dayv2:*` are not readable by old code; the
conservative direction is to leave the poison in place (old code stays parked,
nothing overspends).

---

## 6. Recovery procedures

* **Stuck RESERVED (R)** — e.g. crash or Redis failure before the attempt
  marker. Provably nothing was broadcast (the marker precedes the adapter).
  Recover with `releaseDailySpend(..., { reason: "UNATTEMPTED" })` after
  confirming no adapter invocation for that execution id (action records /
  audit). This is the ONLY automatic-adjacent release path and it is state-
  enforced (refused once ATTEMPTING).
* **Stuck ATTEMPTING (A)** — crash after the marker: the transaction MAY have
  been broadcast. **Never release.** Verify on-chain (same machinery as the
  goal verification pass) or reconcile manually, then
  `markSpendAmbiguous(...)` (A→X, spend stays counted) or let the normal
  commit path close it once verification reports.
* **AMBIGUOUS (X)** — terminal consumed state. No recovery changes totals for
  that day; reconcile the goal/transaction separately.
* **Missing hash behind a fence (`LEDGER_UNAVAILABLE`)** — run
  `RedisAutonomyStore.restoreDayLedger(policyId, dayKey)` (rebuilds from
  `dayarchive:*`, validates first, refuses without an archive). Never creates
  zero totals.
* **Malformed legacy CSV (`MALFORMED_LEGACY`)** — repair the `day:*` value by
  hand (digit strings, comma-separated) and re-run; nothing was migrated or
  reset automatically.

---

## 7. Test evidence map

| Requirement | Suite |
| --- | --- |
| concurrent goals sharing one policy; atomic caps | `daily-spend-reservations.test.ts`, `hardening-gaps.test.ts` (existing) |
| duplicate execution ids / retries | `daily-spend-reservations.test.ts`, `reservation-lifecycle.runtime.test.ts` |
| release / commit / ambiguous / crash-after-marker | `daily-spend-reservations.test.ts`, `reservation-lifecycle.runtime.test.ts` |
| Redis outage & lost reservation response | `reservation-lifecycle.runtime.test.ts` |
| legacy CSV present/absent/malformed/empty/fenced | `legacy-ledger-migration.test.ts` |
| old writer after fencing; concurrent/stale writers | `legacy-ledger-migration.test.ts`, `daily-spend.redis.test.ts` |
| missing hash behind fence | `legacy-ledger-migration.test.ts`, `daily-spend.redis.test.ts` |
| exact large integer amounts | both store suites + real-redis |
| switch refusal behavior | `reservation-lifecycle.runtime.test.ts` |
| one-broadcast safety (existing) | `runtime.test.ts`, `hardening-concurrency.test.ts`, `hardening-gaps.test.ts` |
| real-Redis concurrency + migration (CI-pinned Redis) | `daily-spend.redis.test.ts` + `real-redis` CI job |

The CI `real-redis` job pins `redis:7.4.2` and runs the suite with
`REDIS_URL` set; locally the suite is skipped unless `REDIS_URL` is provided.
All suites execute the **canonical** Lua in `day-ledger-scripts.ts` (via the
store); the only duplicated script text is the deliberate frozen old-writer
fixture in `__tests__/legacy-writer-fixture.ts`.
