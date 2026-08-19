// lib/games/games-reward-config.ts
//
// Game Rewards Module — FINAL production configuration for the weekly
// competitive MPGR settlement. This is the single source of truth for
// every economic constant the settlement engine
// (lib/reward-allocation/settlement-engine.ts) and the API routes
// (app/api/games/mpgr-run/reward, app/api/games/mpgr-run/settlement) use.
// No number here is duplicated anywhere else — importers always read
// from this file.
//
// Corrects/finalizes the "previous Claude" scaffolding: this file did
// not exist before. Every figure below is a deliberate, conservative
// production choice within the caller's LOCKED economics (see the master
// handoff prompt, sections 1 and 33):
//
//   GAME lifetime budget:  7,000,000 MPGR  (hard ceiling, enforced by
//                            lib/reward-allocation ledger, NOT by the
//                            vault contract itself)
//   OTHER Reward Vault budget: 8,000,000 MPGR (Games must never touch it —
//                            this file has no path that can spend from it;
//                            the ledger key is scoped to "GAME" only)
//
// All raw amounts are bigint, 18-decimal MPGR, matching
// lib/reward-vault/reward-vault-types.ts's convention.

const DECIMALS = 18n;
const ONE_MPGR = 10n ** DECIMALS;

// --- Lifetime budget (LOCKED — see master prompt section 1) ---------------

export const GAMES_LIFETIME_BUDGET_RAW = 7_000_000n * ONE_MPGR;

// --- Weekly pool -----------------------------------------------------------
//
// 7,000,000 MPGR spent at this weekly cap gives a ~200-week (~3.8 year)
// runway even if every single week hits the cap, which is intentionally
// conservative — actual spend will usually be lower once
// remainingGamesBudget/vault availableBalance are factored in (see
// computeWeeklyPool in settlement-engine.ts, which takes the min of all
// three). Unused weekly budget is simply never spent — it is NOT rolled
// forward or redistributed, so it can never cause the 7M lifetime
// invariant to be exceeded.
export const WEEKLY_POOL_CAP_RAW = 35_000n * ONE_MPGR;

// ISO week (UTC, Monday 00:00:00.000 start) is the settlement cadence.
export const WEEK_TIMEZONE = "UTC" as const;

// --- Eligibility -------------------------------------------------------------
//
// A player must complete this many SERVER-VALIDATED runs in the week
// before they are eligible for any share of the weekly pool. Chosen well
// above 1 so a single lucky/forged run can never meaningfully consume the
// pool, while staying low enough that a normal casual session (a handful
// of runs) clears it. This is intentionally independent of
// DAILY_XP_RUN_CAP (10) — extra runs past the XP cap still count toward
// this threshold and toward weighting, per the product requirement.
export const MIN_VALID_RUNS_FOR_ELIGIBILITY = 5;

// --- Weighting formula -------------------------------------------------------
//
// rawWeight = boundedRunContribution + boundedScoreContribution
//             (+ boundedSeasonPointContribution, currently always 0 —
//             see the note below)
// normalizedWeight = playerRawWeight / totalRawWeight (over eligible
//   players only, computed once per settlement)
//
// Each contribution is capped BEFORE summing, so no single input can
// dominate a player's weight without bound (spam-resistant: running the
// same short run 500 times caps out at RUN_COUNT_NORMALIZATION_CAP just
// like running it 30 times).
//
// IMPORTANT — Season Points gap: the master prompt's architecture calls
// for a seasonPointsEarnedThisWeek contribution read directly from
// lib/xp-engine.ts's getSeasonPoints(). That function's entire storage
// layer is client-side localStorage (see xp-engine.ts's own header
// comment) — there is no server-side source of truth for a wallet's XP
// history today, and building one is a full XP-system migration that
// section 3 of the master prompt explicitly puts out of scope ("EXISTING
// XP — DO NOT CHANGE"). Rather than trust a client-submitted season-point
// number as a weighting input (which the security section explicitly
// forbids trusting for anything economic), SEASON_POINTS_WEIGHT is set to
// 0 so the term is always 0 and the formula degrades to using only
// server-verified inputs (validRunCount, bestScore). The field stays in
// PlayerWeekRecord and the code path stays wired so flipping this one
// constant is the only change needed once XP has a server-side store.
export const RUN_COUNT_WEIGHT = 55; // max points contributed by validRunCount
export const BEST_SCORE_WEIGHT = 45; // max points contributed by bestScore
export const SEASON_POINTS_WEIGHT = 0; // disabled — see note above

// A player's validRunCount is normalized against this cap before scaling
// by RUN_COUNT_WEIGHT — i.e. contribution saturates at this many runs/week.
export const RUN_COUNT_NORMALIZATION_CAP = 40;

// A player's bestScore for the week is normalized against this cap before
// scaling by BEST_SCORE_WEIGHT. Chosen well above a typical strong single
// run (see lib/games/mpgr-run/run-score.ts's weights) so the top of the
// curve rewards genuinely excellent runs without being trivially maxed.
export const BEST_SCORE_NORMALIZATION_CAP = 20_000;

export const SEASON_POINTS_NORMALIZATION_CAP = 1; // unused while weight is 0

// --- Per-user safety ---------------------------------------------------------

// Below this, an allocation is dust — safely left unallocated rather than
// wasting a batch-array slot and gas on a near-zero transfer.
export const MIN_MEANINGFUL_ALLOCATION_RAW = ONE_MPGR / 10n; // 0.1 MPGR

// No single player can be allocated more than this fraction of a given
// week's actual pool, however skewed the weighting turns out to be.
export const MAX_SHARE_OF_WEEKLY_POOL_PER_PLAYER = 0.2; // 20%

export const GAMES_REWARD_CONFIG = {
  gamesLifetimeBudgetRaw: GAMES_LIFETIME_BUDGET_RAW,
  weeklyPoolCapRaw: WEEKLY_POOL_CAP_RAW,
  minValidRunsForEligibility: MIN_VALID_RUNS_FOR_ELIGIBILITY,
  weighting: {
    runCountWeight: RUN_COUNT_WEIGHT,
    bestScoreWeight: BEST_SCORE_WEIGHT,
    seasonPointsWeight: SEASON_POINTS_WEIGHT,
    runCountNormalizationCap: RUN_COUNT_NORMALIZATION_CAP,
    bestScoreNormalizationCap: BEST_SCORE_NORMALIZATION_CAP,
    seasonPointsNormalizationCap: SEASON_POINTS_NORMALIZATION_CAP,
  },
  minMeaningfulAllocationRaw: MIN_MEANINGFUL_ALLOCATION_RAW,
  maxShareOfWeeklyPoolPerPlayer: MAX_SHARE_OF_WEEKLY_POOL_PER_PLAYER,
} as const;

export type GamesRewardConfig = typeof GAMES_REWARD_CONFIG;
