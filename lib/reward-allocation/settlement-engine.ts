// lib/reward-allocation/settlement-engine.ts
//
// Game Rewards Module — pure settlement math. No I/O, no chain calls, no
// persistence — every function here is deterministic and independently
// testable, which is what lets app/api/games/mpgr-run/settlement/route.ts
// (the only caller) stay a thin orchestration layer over this.

import {
  BEST_SCORE_NORMALIZATION_CAP,
  BEST_SCORE_WEIGHT,
  GAMES_LIFETIME_BUDGET_RAW,
  MAX_SHARE_OF_WEEKLY_POOL_PER_PLAYER,
  MIN_MEANINGFUL_ALLOCATION_RAW,
  MIN_VALID_RUNS_FOR_ELIGIBILITY,
  RUN_COUNT_NORMALIZATION_CAP,
  RUN_COUNT_WEIGHT,
  SEASON_POINTS_NORMALIZATION_CAP,
  SEASON_POINTS_WEIGHT,
  WEEKLY_POOL_CAP_RAW,
} from "@/lib/games/games-reward-config";
import type { PlayerWeekRecord } from "./allocation-types";

// --- Week boundaries (ISO week, UTC) ---------------------------------------
//
// weekKey format: "YYYY-Www" (e.g. "2026-W34"), ISO-8601 week numbering,
// Monday 00:00:00.000 UTC as the week start. Chosen over the existing XP
// engine's calendar-month "season" because a week is a much tighter,
// clearly-bounded settlement cadence — see
// lib/reward-allocation/reward-vault-season-mapping.ts for how this
// nests inside the broader XP season for on-chain seasonId purposes.

function isoWeekParts(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO: weeks start Monday; Thursday of the week determines the week's year.
  const dayNum = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: d.getUTCFullYear(), week };
}

export function getWeekKey(date: Date = new Date()): string {
  const { year, week } = isoWeekParts(date);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday 00:00:00.000 UTC .. next Monday 00:00:00.000 UTC (exclusive) for a given weekKey. */
export function getWeekBounds(weekKey: string): { weekStart: Date; weekEnd: Date } {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!match) throw new Error(`Invalid weekKey: ${weekKey}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  // ISO week 1's Monday is the Monday of the week containing Jan 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const weekStart = new Date(week1Monday);
  weekStart.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);
  return { weekStart, weekEnd };
}

/** The weekKey immediately before the one containing `date` — i.e. "the most recently closed week" at settlement time. */
export function getPreviousWeekKey(date: Date = new Date()): string {
  const { weekStart } = getWeekBounds(getWeekKey(date));
  const prev = new Date(weekStart);
  prev.setUTCDate(prev.getUTCDate() - 1); // a day inside the previous week
  return getWeekKey(prev);
}

// --- Eligibility -------------------------------------------------------------

export function resolveEligibility(validRunCount: number): "eligible" | "pending" {
  return validRunCount >= MIN_VALID_RUNS_FOR_ELIGIBILITY ? "eligible" : "pending";
}

// --- Weighting ---------------------------------------------------------------
//
// Deterministic, bounded, spam-resistant. See
// lib/games/games-reward-config.ts's header comment for the full
// rationale, including why the Season Points term is currently always 0.

function boundedContribution(value: number, cap: number, weight: number): number {
  if (cap <= 0 || weight <= 0) return 0;
  const fraction = Math.max(0, Math.min(1, value / cap));
  return fraction * weight;
}

export function computeRawWeight(record: Pick<PlayerWeekRecord, "validRunCount" | "bestScore" | "seasonPointsEarnedThisWeek">): number {
  const runContribution = boundedContribution(record.validRunCount, RUN_COUNT_NORMALIZATION_CAP, RUN_COUNT_WEIGHT);
  const scoreContribution = boundedContribution(record.bestScore, BEST_SCORE_NORMALIZATION_CAP, BEST_SCORE_WEIGHT);
  const seasonContribution = boundedContribution(
    record.seasonPointsEarnedThisWeek,
    SEASON_POINTS_NORMALIZATION_CAP,
    SEASON_POINTS_WEIGHT
  );
  return runContribution + scoreContribution + seasonContribution;
}

// --- Weekly pool ---------------------------------------------------------------

export function computeWeeklyPool(remainingGamesBudgetRaw: bigint, vaultAvailableBalanceRaw: bigint): bigint {
  let pool = WEEKLY_POOL_CAP_RAW;
  if (remainingGamesBudgetRaw < pool) pool = remainingGamesBudgetRaw;
  if (vaultAvailableBalanceRaw < pool) pool = vaultAvailableBalanceRaw;
  return pool < 0n ? 0n : pool;
}

export function remainingGamesBudget(treasuryLedgerTotalRaw: bigint): bigint {
  const remaining = GAMES_LIFETIME_BUDGET_RAW - treasuryLedgerTotalRaw;
  return remaining < 0n ? 0n : remaining;
}

// --- Allocation ------------------------------------------------------------

export interface AllocationInput {
  wallet: string;
  rawWeight: number;
}

export interface AllocationOutput {
  wallet: string;
  normalizedWeight: number;
  amountRaw: bigint;
}

/**
 * Splits `poolRaw` across `players` proportional to rawWeight, applying
 * the per-player max-share cap and the dust floor. Deterministic: same
 * inputs always produce the same amounts (integer floor division, no
 * randomness). The sum of every returned amountRaw is guaranteed <=
 * poolRaw.
 */
export function computeAllocations(players: AllocationInput[], poolRaw: bigint): AllocationOutput[] {
  const totalRawWeight = players.reduce((sum, p) => sum + p.rawWeight, 0);
  if (poolRaw <= 0n || totalRawWeight <= 0 || players.length === 0) {
    return players.map((p) => ({ wallet: p.wallet, normalizedWeight: 0, amountRaw: 0n }));
  }

  const maxPerPlayerRaw = bigintFromFraction(poolRaw, MAX_SHARE_OF_WEEKLY_POOL_PER_PLAYER);

  const results: AllocationOutput[] = players.map((p) => {
    const normalizedWeight = p.rawWeight / totalRawWeight;
    let amountRaw = bigintFromFraction(poolRaw, normalizedWeight);
    if (amountRaw > maxPerPlayerRaw) amountRaw = maxPerPlayerRaw;
    if (amountRaw < MIN_MEANINGFUL_ALLOCATION_RAW) amountRaw = 0n;
    return { wallet: p.wallet, normalizedWeight, amountRaw };
  });

  // Enforce the hard invariant: sum(amountRaw) <= poolRaw even after the
  // per-player cap (capping can, in pathological distributions, still
  // leave the naive sum at or fractionally over pool due to floor
  // rounding elsewhere) — clip the last entries down if needed rather
  // than ever allocating more than the pool.
  let total = results.reduce((sum, r) => sum + r.amountRaw, 0n);
  if (total > poolRaw) {
    let excess = total - poolRaw;
    for (let i = results.length - 1; i >= 0 && excess > 0n; i--) {
      const reducible = results[i].amountRaw < excess ? results[i].amountRaw : excess;
      results[i] = { ...results[i], amountRaw: results[i].amountRaw - reducible };
      excess -= reducible;
    }
  }

  return results;
}

function bigintFromFraction(amount: bigint, fraction: number): bigint {
  if (fraction <= 0) return 0n;
  if (fraction >= 1) return amount;
  // Scale to avoid float precision loss on very large bigints: use
  // integer basis points (1e9 precision) rather than multiplying a
  // bigint by a float directly.
  const basisPoints = BigInt(Math.round(fraction * 1_000_000_000));
  return (amount * basisPoints) / 1_000_000_000n;
}
