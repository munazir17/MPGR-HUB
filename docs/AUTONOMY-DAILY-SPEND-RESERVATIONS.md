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
| `mpgrhub:autonomy:dayarchive:{policyId}:{day}` | exact copy of the legacy CSV at migration time (operator recovery source). **Limitation:** it can never contain post-migration reservations |
| `mpgrhub:autonomy:daygen:{policyId}:{day}` | **write-witness**: `"0"` at import, `INCR`'d by every mutation (new reservation, attempt, commit, ambiguous, release). Survives hash loss; the arbiter of whether `restoreDayLedger` may rebuild a lost hash (§6) |

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

**Migration trigger: LAZY — this is the only mechanism that exists.**
`ensure_day_ledger()` is called by every day-ledger script (`getDayLedger`,
`reserveDailySpend`, and the lifecycle/release/restore scripts) and performs
the migration **exactly once per policy-day, on the first day-ledger access,
in one atomic Lua operation**. There is NO explicit migration API, method, or
operator job — do not plan the rollout around running one. (`restoreDayLedger`
(§6) is the only explicit operator entry point, and it is recovery, not
migration.)

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
   key, the **poison** into the legacy key, and the **write-witness**
   `daygen = "0"`. The witness makes import exactly-once: once it exists, a
   lost hash can never be silently re-imported from the (incomplete) archive,
   and `restoreDayLedger` can tell "nothing wrote after the import" (`"0"`)
   from "post-migration reservations existed" (`> 0`).

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
| missing hash behind an existing fence, nothing wrote after import (`daygen` = "0") | `LEDGER_UNAVAILABLE` (**not** zero); `restoreDayLedger` rebuilds the full authoritative ledger from the archive | same |
| hash lost after a **committed** reservation | `restoreDayLedger` **fails closed** (`LEDGER_UNAVAILABLE`) — archive-only totals would undercount | same + real-redis suite |
| hash lost after a **reserved** (in-flight) reservation | `restoreDayLedger` **fails closed** | same |
| hash lost after an **ambiguous** reservation | `restoreDayLedger` **fails closed** (uncertain spend must stay counted) | same |
| hash+fence loss with witness present | never re-imported, never zeroed — `LEDGER_UNAVAILABLE` | same |
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
  being fixed). The drain procedure in §5 closes that window by disabling old
  writers BEFORE cutover; the atomic import-or-refuse serialization (§3.2)
  covers any straggler that slips past the drain. Until an operator executes
  §5 against production, the migration must NOT be claimed safe in production.
* **NOT VERIFIED:** production environment variables / KV (untouched by this
  work; `AUTONOMOUS_PRODUCTION_ENABLED` remains OFF and was not modified).

---

## 5. Deployment / rolling-deploy sequence (operator runbook)

**How the migration is actually triggered (the implementation that exists):**
lazily and atomically on the first day-ledger access per policy-day
(`ensure_day_ledger()` — §3). There is no migration job, script, or API to run.
The fence/poison is the hard **data-layer** stop for old writers and does not
depend on which instances are running (frozen old writer refused after the
fence — **VERIFIED** by tests).

**Platform reality — read before planning any Vercel rollout:** changing an
environment variable on Vercel does **NOT** change instances that are already
running. An env change reaches code only via a **new deployment** (new
instances get the new env; old instances finish in-flight requests and exit).
Steps below that depend on instance env or instance replacement are marked
**[platform — NOT VERIFIED here]**; steps marked **[VERIFIED]** are enforced
by code and tests in this repository and hold regardless of the platform.

Sequence — old writers are disabled **before** cutover:

1. **Freeze the fleet.** Set `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` as a
   production env var **and redeploy the CURRENT release**, so every serving
   instance actually carries the flag. **[platform — NOT VERIFIED]** The flag
   exists in BOTH old and new code and gates every evaluation in-process
   **[VERIFIED: hardening-concurrency tests]** — but it cannot affect an
   instance that never received it; setting the variable alone is not enough.
2. **Drain in-flight work.** After that redeploy completes, wait at least
   `evaluationLeaseSeconds` (120 s) — the lease bound **[VERIFIED]** — plus
   the verification window (up to 900 s) for an execution already past its
   pre-check; worst case an execution is in-flight up to `executionGuard`
   (24 h). Keep the disable ON for the whole window if any autonomous
   activity is unaccounted. **[production timing — NOT VERIFIED here]** No new
   evaluation starts on any instance once the flag is live; the drain exists
   to close the old-vs-old pre-fix TOCTOU during any remaining rollout window.
3. **Cutover: deploy the new release.** With old writers drained, the lazy
   migration fences each policy-day on first access
   **[VERIFIED: atomic import-or-refuse (§3.2); fence refuses frozen old
   writers]**. If a straggling old instance slipped past step 2 and wrote into
   a not-yet-fenced day, that write is imported-or-refused atomically — never
   lost, never double-counted **[VERIFIED: §3.2]**.
4. **Verify (read-only):** inspect `mpgrhub:autonomy:dayv2:*` hashes
   (`total`/`count`/`migrated`) and `mpgrhub:autonomy:day:{policyId}:{day}` =
   poison for active policy-days; confirm `AUTONOMOUS_PRODUCTION_ENABLED` is
   unchanged. **[production inspection — operator-side, NOT VERIFIED here]**
5. **Re-enable.** Clear `MPGR_AUTONOMOUS_EMERGENCY_DISABLE` (or set `false`)
   **and redeploy** — as in step 1, an env change alone reaches nothing that
   is already running. **[platform — NOT VERIFIED]** The first evaluation after
   the re-enable deploy is the canary.

**Midnight note.** The fence is per policy-UTC-day. Keep the emergency disable
ON across 00:00 UTC if old instances could still be alive — the drain, not the
fence, is what stops a straggling old instance from writing into the next
day's (not-yet-fenced) CSV. Any such write is imported-or-refused on that
day's first new-code access (§3.2) — never lost.

**Rollback.** Set `MPGR_AUTONOMOUS_EMERGENCY_DISABLE=true` **and redeploy**
first **[platform — NOT VERIFIED]**, then deploy the previous release. The old
code reads the legacy CSV key — which now holds the poison — and fails
**closed** (spend pre-check huge/OVER_ACTION_RATE; the old append is refused),
so a rollback cannot overspend **[VERIFIED: frozen-writer tests]**. If goals
must run on the old code after rollback, an operator may `DEL` the poisoned
`day:*` key and restore its archived CSV **only for policy-days without
post-migration reservations** (check `daygen`: `"0"` = only the import ever
wrote, or the key is absent because the day was never migrated). For any day
with `daygen` > 0, leave the poison in place: the old code cannot see
`dayv2:*` reservations and would spend against an incomplete total.

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
  `RedisAutonomyStore.restoreDayLedger(policyId, dayKey)`. It rebuilds from
  `dayarchive:*` **only when the `daygen` write-witness is `"0"`** — i.e.
  nothing was written after the import and the archive IS the full
  authoritative ledger (validated first; refuses without an archive; never
  creates zero totals). If the witness is `> 0` (committed, reserved,
  ambiguous, released or attempted entries existed), those entries lived only
  in the lost hash: the archive cannot contain them and any restore would
  **undercount** daily spend, so restore **fails closed** (`LEDGER_UNAVAILABLE`)
  — reconcile manually from action records / audit / on-chain state and write
  the hash back by hand. A **missing** witness also fails closed (completeness
  cannot be proven).
* **Malformed legacy CSV (`MALFORMED_LEGACY`)** — repair the `day:*` value by
  hand (digit strings, comma-separated); the **next ledger access** retries the
  import automatically (the migration is lazy — §3). Nothing was migrated or
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
| missing hash behind fence (restore when witness = "0") | `legacy-ledger-migration.test.ts`, `daily-spend.redis.test.ts` |
| hash loss after committed / reserved / ambiguous reservations (restore fails closed) | `legacy-ledger-migration.test.ts`, `daily-spend.redis.test.ts` |
| hash+fence loss with witness (no re-import, no zero) | `legacy-ledger-migration.test.ts` |
| exact large integer amounts | both store suites + real-redis |
| switch refusal behavior | `reservation-lifecycle.runtime.test.ts` |
| one-broadcast safety (existing) | `runtime.test.ts`, `hardening-concurrency.test.ts`, `hardening-gaps.test.ts` |
| real-Redis concurrency + migration (CI-pinned Redis) | `daily-spend.redis.test.ts` + `real-redis` CI job |

The CI `real-redis` job pins `redis:7.4.2` and runs the suite with
`REDIS_URL` set; locally the suite is skipped unless `REDIS_URL` is provided.
All suites execute the **canonical** Lua in `day-ledger-scripts.ts` (via the
store); the only duplicated script text is the deliberate frozen old-writer
fixture in `__tests__/legacy-writer-fixture.ts`.
