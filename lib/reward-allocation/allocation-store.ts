// lib/reward-allocation/allocation-store.ts
//
// Game Rewards Module — persistence abstraction for weekly competitive
// settlement. INTERFACE ONLY. No implementation is provided in this file
// and none should be added here without an explicit, approved persistence
// provider (Postgres/Vercel KV/Upstash/etc. — none is installed in this
// repo's package.json today, and none is chosen here).
//
// Why an interface and not even a stub in-memory implementation: an
// in-memory Map looks like duplicate/idempotency protection but silently
// stops providing it the moment there's more than one server instance,
// a redeploy, or a cold start — worse than having none, because it hides
// the gap instead of surfacing it. See the architecture audit in chat
// history for the full reasoning. Nothing in this repo currently
// implements AllocationStore; app/api/games/mpgr-run/reward/route.ts does
// NOT import this file and continues to return 501.
//
// Concurrency contract every real implementation MUST satisfy — this is
// the whole point of the interface, not an incidental detail:
//   - putRunRecordIfAbsent must be atomic ("insert if the sessionId key
//     doesn't already exist, else no-op and report the existing record")
//     so two concurrent submissions of the same sessionId can never both
//     succeed.
//   - upsertPlayerWeekRecord must support an optimistic-concurrency
//     guard (expectedStatus) so a settlement job resuming after a crash
//     can never clobber a record another process already advanced past
//     "pending" into "allocated"/"failed".
//   - recordTreasuryLedgerEntry must be atomic relative to concurrent
//     entries (e.g. an atomic increment, or a serializable transaction)
//     so two settlements running concurrently can never both read the
//     same "remaining budget" and overspend it — see the weekly-pool
//     architecture (D) in chat history.

import type { Address } from "viem";
import type {
  AllocationStatus,
  PlayerWeekRecord,
  RunRecord,
  WeeklySettlement,
} from "./allocation-types";

/** Result of an insert-if-absent attempt, so a caller can distinguish "I inserted it" from "it was already there" without a separate read. */
export interface InsertResult<T> {
  inserted: boolean;
  record: T;
}

/**
 * Every method that mutates state is async and expected to hit real,
 * durable storage — no method here is allowed to be backed by a plain
 * in-process object for anything beyond local unit tests.
 */
export interface AllocationStore {
  // --- Run-level idempotency (see B. Weekly Eligibility) -----------------

  getRunRecord(sessionId: string): Promise<RunRecord | null>;

  /**
   * Atomic insert-if-absent. If a record for this sessionId already
   * exists, MUST return { inserted: false, record: <existing> } rather
   * than overwriting it — this is the mechanism that makes "a run can
   * only ever be counted once" actually true under concurrent/duplicate
   * submissions, not just true when requests happen to arrive serially.
   */
  putRunRecordIfAbsent(record: RunRecord): Promise<InsertResult<RunRecord>>;

  // --- Per-player weekly ledger (see A. Game Performance Ledger) --------

  getPlayerWeekRecord(
    wallet: Address,
    weekKey: string
  ): Promise<PlayerWeekRecord | null>;

  /**
   * Conditional upsert. When expectedStatus is provided, the
   * implementation MUST only apply the write if the currently-stored
   * record's allocationStatus matches expectedStatus (or the record
   * doesn't exist yet and expectedStatus is undefined/"none") —
   * otherwise it must reject/no-op rather than silently overwrite a
   * status another process already advanced. This is what lets a
   * crashed-and-resumed settlement job safely retry without racing a
   * still-running one.
   */
  upsertPlayerWeekRecord(
    record: PlayerWeekRecord,
    expectedStatus?: AllocationStatus
  ): Promise<PlayerWeekRecord>;

  /** Every PlayerWeekRecord with eligibilityStatus === "eligible" for a given week, for the settlement job to weight/pool over. */
  listEligiblePlayersForWeek(weekKey: string): Promise<PlayerWeekRecord[]>;

  // --- Whole-week settlement state (see H. Weekly Settlement) -----------

  getWeeklySettlement(weekKey: string): Promise<WeeklySettlement | null>;

  /** Same conditional-write contract as upsertPlayerWeekRecord, keyed on WeeklySettlement.status instead. */
  upsertWeeklySettlement(
    settlement: WeeklySettlement,
    expectedStatus?: WeeklySettlement["status"]
  ): Promise<WeeklySettlement>;

  // --- Mini Games treasury ledger (see D. Weekly Pool) --------------------

  /**
   * Running total of raw MPGR already allocated under RewardType.GAME
   * across all finalized settlements — the off-chain bookkeeping figure
   * that, subtracted from the 15,000,000 MPGR budget documented in
   * docs/REWARDS.md, gives remainingMiniGamesTreasuryBudget. This is
   * NOT enforced on-chain by the vault itself (it has no concept of a
   * "Mini Games" category), so this ledger is the only thing that can
   * enforce the documented budget as a ceiling.
   */
  getTreasuryLedgerTotal(rewardType: "GAME"): Promise<bigint>;

  /**
   * Atomically increases the ledger total. Must be safe under
   * concurrent settlements (see concurrency contract above) — e.g. an
   * atomic increment rather than read-then-write.
   */
  recordTreasuryLedgerEntry(rewardType: "GAME", amountRaw: bigint): Promise<void>;
}
