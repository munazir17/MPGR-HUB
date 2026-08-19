// lib/reward-allocation/allocation-types.ts
//
// Game Rewards Module — shared types for the (not-yet-implemented) weekly
// competitive MPGR settlement described in the Game Rewards architecture
// audit. This file defines shape only: no persistence, no calculation, no
// on-chain calls. Nothing here is wired into any running code path yet —
// app/api/games/mpgr-run/reward/route.ts continues to return 501 and does
// not import from this module.
//
// Deliberately server-side-only in spirit (these records hold per-wallet
// competitive/allocation state that should never be assembled or trusted
// client-side) even though nothing here is Node-specific — do not import
// this file from a "use client" component.
//
// Design constraints these types encode (see chat history for the full
// architecture — this is the "A. GAME PERFORMANCE LEDGER" section):
//   - XP and MPGR are separate: nothing here computes or stores an
//     XP->MPGR conversion. seasonPointsEarnedThisWeek is READ from the
//     existing lib/xp-engine.ts Season Points concept, never recomputed.
//   - No fixed per-run payout: RunRecord tracks that a run happened and
//     passed validation, not any reward amount — only PlayerWeekRecord
//     (assembled at settlement time, once a week) ever carries an MPGR
//     amount, and only after weighting/pool math (not yet implemented).
//   - Token amounts are always bigint (raw, 18-decimal MPGR), matching
//     lib/reward-vault/reward-vault-types.ts's VaultReward.amount and
//     lib/rewards/reward-types.ts's RewardCategorySummary convention —
//     never a plain number, so settlement math never loses precision.

import type { Address, Hash } from "viem";
import type { RunResult } from "@/lib/games/mpgr-run/run-score";

// --- Shared enums ------------------------------------------------------

/**
 * Lifecycle of a single player's weekly MPGR allocation.
 *
 * "none"      — week not yet settled for this player (or player not yet
 *                seen this week).
 * "pending"   — settlement has computed an amount and persisted this
 *                record, but the on-chain allocateReward/allocateRewardsBatch
 *                call has not yet been confirmed successful. A crash or
 *                retry between these two states must resume from here,
 *                never silently re-derive a new amount.
 * "allocated" — the on-chain call succeeded; rewardId/allocationTxHash
 *                are populated and reflect a real, confirmed transaction.
 * "failed"    — the on-chain call was attempted and did not succeed
 *                (reverted, or confirmation never landed). Safe to retry
 *                from "failed" only after re-checking on-chain state
 *                (see AllocationStore) to avoid double allocation.
 */
export type AllocationStatus = "none" | "pending" | "allocated" | "failed";

/**
 * Whether a player's frozen weekly performance data qualifies them for
 * this week's pool at all. Distinct from AllocationStatus: a player can
 * be "eligible" with weight > 0 for a week whose settlement hasn't run
 * yet (allocationStatus still "none"), or "ineligible" (didn't meet the
 * minimum-valid-runs bar or other eligibility rule — exact rule is
 * CONFIG/DECISION REQUIRED, not encoded in this type file).
 */
export type EligibilityStatus = "pending" | "eligible" | "ineligible";

/** Lifecycle of an entire week's settlement run, independent of any one player's AllocationStatus. */
export type SettlementStatus =
  | "open" // week still accepting RunRecords
  | "closed" // week frozen, no more RunRecords accepted, weighting not yet computed
  | "computed" // weights/pool/amounts computed and persisted, nothing allocated on-chain yet
  | "allocating" // on-chain allocation in progress (batch submitted, awaiting confirmation)
  | "finalized" // all eligible players reached a terminal AllocationStatus ("allocated" or explicitly "failed" and accepted as such)
  | "aborted"; // settlement was halted before allocation (e.g. a safety check in step H.6/H.7 failed) — no on-chain call was made

// --- Per-run record ------------------------------------------------------

/**
 * One accepted, server-validated run. This is the idempotency unit for
 * "was this run already counted toward weekly eligibility" — sessionId
 * uniqueness (enforced by AllocationStore, not here) is what prevents a
 * resubmitted/replayed run from being counted twice.
 *
 * Does NOT carry a reward amount — a run contributes to eligibility/
 * weighting inputs only; no RunRecord is ever itself "worth" MPGR.
 */
export interface RunRecord {
  /** Client-generated session id from lib/games/game-session.ts's startSession(). Unique per run; the idempotency key for this record. */
  sessionId: string;
  /** Lowercased wallet address the run is attributed to. */
  wallet: Address;
  /** Which settlement week this run falls into — see reward-vault-season-mapping.ts for how weekKey/seasonId boundaries are decided (unresolved). */
  weekKey: string;
  /** Server clock time the run was received/recorded, ISO 8601. */
  submittedAt: string;
  /** True only if lib/games/mpgr-run/run-validation.ts's validateRunResult() (re-run server-side) accepted this run. An unvalidated/rejected run may still be recorded for audit purposes with this set to false, but must never contribute to eligibility/weighting. */
  serverValidated: boolean;
  /** Full submitted result, kept for audit/dispute purposes only. Never re-trusted as authorization for an amount by itself — see the anti-cheat limitations already noted in the architecture audit (validateRunResult proves internal consistency, not that a run was genuinely played). */
  result: RunResult;
}

// --- Per-player, per-week record ------------------------------------------

/**
 * One player's frozen, aggregated performance + settlement state for one
 * (seasonId, weekKey). Assembled from RunRecords + the existing XP engine's
 * Season Points — never independently recomputed from raw client data at
 * settlement time, so the numbers a player sees always trace back to
 * events that were already validated when they happened.
 */
export interface PlayerWeekRecord {
  wallet: Address;
  /** Vault seasonId this week's allocation would be recorded under — see reward-vault-season-mapping.ts. May be unset/null until the season mapping decision (G) is resolved. */
  seasonId: bigint | null;
  weekKey: string;

  /** Count of RunRecords with serverValidated === true for this (wallet, weekKey). */
  validRunCount: number;
  /** Highest RunResult.score among this week's valid runs. */
  bestScore: number;
  /**
   * Optional secondary aggregate (e.g. sum of valid-run scores), only
   * populated if the (not-yet-approved) weighting formula needs it.
   * Left optional/undefined rather than guessing which aggregate the
   * approved formula will actually use.
   */
  totalScore?: number;

  /** Read directly from lib/xp-engine.ts's getSeasonPoints() for this wallet, scoped to this week — never recomputed independently. */
  seasonPointsEarnedThisWeek: number;

  /** ISO 8601 timestamp of the most recent valid run counted this week. */
  lastRunAt: string | null;

  eligibilityStatus: EligibilityStatus;

  /**
   * Deterministic weight computed at settlement time from the fields
   * above, per the (not-yet-approved) weighting formula. Null until
   * settlement actually runs for this week.
   */
  weight: number | null;

  /** Raw (18-decimal) MPGR this player was allocated this week. Null until settlement computes it; must never be treated as "owed" or displayed to the player before allocationStatus reaches "allocated". */
  allocatedAmountRaw: bigint | null;

  /** On-chain reward id returned by allocateReward/allocateRewardsBatch, populated only once allocationStatus is "allocated". */
  rewardId: bigint | null;

  /** Transaction hash of the confirmed allocation, populated only once allocationStatus is "allocated". */
  allocationTxHash: Hash | null;

  allocationStatus: AllocationStatus;
}

// --- Whole-week settlement record -----------------------------------------

/**
 * One row per (seasonId, weekKey) describing the settlement run as a
 * whole — separate from any individual PlayerWeekRecord so the
 * open/closed/computed/allocating/finalized lifecycle (and the safety
 * totals below) can be inspected and resumed independently of any one
 * player's state.
 */
export interface WeeklySettlement {
  seasonId: bigint | null;
  weekKey: string;

  status: SettlementStatus;

  /** ISO 8601 boundaries of the settlement week. Convention (e.g. UTC Monday 00:00) is CONFIG/DECISION REQUIRED — not encoded here. */
  weekStart: string;
  weekEnd: string;

  /** Number of PlayerWeekRecords with eligibilityStatus === "eligible" as of the "closed" step. */
  eligiblePlayerCount: number;

  /**
   * The computed weekly pool size (raw MPGR) once status reaches
   * "computed" — see the weekly-pool architecture (D): bounded by a
   * per-week cap, the remaining Mini Games treasury ledger, and the
   * vault's live availableBalance(). Null until computed.
   */
  weeklyPoolRaw: bigint | null;

  /** Sum of every PlayerWeekRecord.allocatedAmountRaw for this settlement, once computed. Must never exceed weeklyPoolRaw — asserted at settlement time (see architecture step H.6), not just assumed. */
  totalAllocatedRaw: bigint | null;

  /** Populated once status reaches "allocating"/"finalized": every rewardId this settlement produced, for audit cross-checking against the vault's getSeasonRewardIds(). */
  rewardIds: bigint[];

  /** Batch or per-tx hash(es) this settlement submitted. */
  allocationTxHashes: Hash[];

  createdAt: string;
  updatedAt: string;
}

export type { Address, Hash };

