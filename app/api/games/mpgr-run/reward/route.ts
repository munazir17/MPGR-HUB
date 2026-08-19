// app/api/games/mpgr-run/reward/route.ts
//
// Game Rewards Module — real implementation (replaces the previous 501
// scaffold; there was in fact no route file here yet, so this is new).
//
// Request: { sessionId, walletAddress, result } — the client MUST NOT
// submit an MPGR amount, a weight, a rank, or an allocation status; none
// of those fields are accepted even if present in the body.
//
// This endpoint does NOT allocate MPGR. It only:
//   1. validates the request shape
//   2. validates the wallet address
//   3. re-validates the RunResult server-side (reusing the existing,
//      pure validateRunResult() — same bounds the client already uses)
//   4. atomically records the run (sessionId idempotency via KV NX)
//   5. if valid, updates this wallet's PlayerWeekRecord for the current
//      settlement week (validRunCount, bestScore, eligibility)
//   6. returns an honest status — never a reward amount, weight, or rank
//
// Runs on Node (not Edge) since it uses @vercel/kv.

import { NextResponse } from "next/server";
import type { Address } from "viem";
import { validateRunResult } from "@/lib/games/mpgr-run/run-validation";
import type { RunResult, RunStats } from "@/lib/games/mpgr-run/run-score";
import { computeRunScore } from "@/lib/games/mpgr-run/run-score";
import { kvAllocationStore } from "@/lib/reward-allocation/kv-allocation-store";
import type { PlayerWeekRecord, RunRecord } from "@/lib/reward-allocation/allocation-types";
import { getWeekKey, resolveEligibility } from "@/lib/reward-allocation/settlement-engine";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const NUMERIC_RUN_FIELDS: (keyof RunStats)[] = [
  "distanceMeters",
  "durationMs",
  "coinsCollected",
  "gemsCollected",
  "xpOrbsCollected",
  "keysCollected",
  "chestsCollected",
  "powerupsCollected",
  "obstaclesPassed",
  "checkpointsReached",
  "bonusScore",
  "hitsTaken",
  "maxSpeedTierReached",
];

interface RewardRequestBody {
  sessionId: string;
  walletAddress: string;
  result: RunResult;
}

function isValidShape(value: unknown): value is RewardRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.sessionId !== "string" || body.sessionId.length < 8 || body.sessionId.length > 128) return false;
  if (typeof body.walletAddress !== "string" || !ADDRESS_RE.test(body.walletAddress)) return false;
  const result = body.result;
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  for (const field of NUMERIC_RUN_FIELDS) {
    const value = r[field as string];
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  if (typeof r.collided !== "boolean") return false;
  if (typeof r.score !== "number" || !Number.isFinite(r.score as number)) return false;
  return true;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidShape(body)) {
    return NextResponse.json(
      { error: "Request must include sessionId (string), walletAddress (0x address), and a full RunResult." },
      { status: 400 }
    );
  }

  const wallet = body.walletAddress.toLowerCase() as Address;
  const sessionId = body.sessionId;

  // Server re-derives the score rather than trusting the submitted one —
  // the client-side validateRunResult() already checks
  // recomputedScore === result.score, but recomputing here too means a
  // tampered `score` field is rejected before it ever reaches storage.
  const recomputedScore = computeRunScore(body.result);
  const resultForValidation: RunResult = { ...body.result, score: recomputedScore };

  // Server-side idempotency check happens via putRunRecordIfAbsent below,
  // not via a client-supplied "processed session ids" list — so pass an
  // empty list into the pure validator here and rely on the atomic KV
  // insert as the actual duplicate-rejection mechanism.
  const validation = validateRunResult(resultForValidation, sessionId, []);

  const weekKey = getWeekKey(new Date());
  const runRecord: RunRecord = {
    sessionId,
    wallet,
    weekKey,
    submittedAt: new Date().toISOString(),
    serverValidated: validation.valid,
    result: resultForValidation,
  };

  const insertResult = await kvAllocationStore.putRunRecordIfAbsent(runRecord);

  if (!insertResult.inserted) {
    return NextResponse.json({
      accepted: false,
      duplicate: true,
      message: "This run was already recorded.",
    });
  }

  if (!validation.valid) {
    return NextResponse.json({
      accepted: false,
      duplicate: false,
      valid: false,
      reasons: validation.reasons,
    });
  }

  // Only update the weekly ledger while the week is still open — once a
  // settlement has closed/computed/allocated a week, further submissions
  // for that (already-passed) weekKey are still recorded for audit
  // (above) but must never retroactively change a frozen PlayerWeekRecord.
  const settlement = await kvAllocationStore.getWeeklySettlement(weekKey);
  const weekIsOpenForContributions = !settlement || settlement.status === "open";

  let playerWeek: PlayerWeekRecord | null = null;

  if (weekIsOpenForContributions) {
    const existing = await kvAllocationStore.getPlayerWeekRecord(wallet, weekKey);
    const base: PlayerWeekRecord = existing ?? {
      wallet,
      seasonId: null,
      weekKey,
      validRunCount: 0,
      bestScore: 0,
      seasonPointsEarnedThisWeek: 0, // see games-reward-config.ts — no server-side XP source yet
      lastRunAt: null,
      eligibilityStatus: "pending",
      weight: null,
      allocatedAmountRaw: null,
      rewardId: null,
      allocationTxHash: null,
      allocationStatus: "none",
    };

    const updated: PlayerWeekRecord = {
      ...base,
      validRunCount: base.validRunCount + 1,
      bestScore: Math.max(base.bestScore, resultForValidation.score),
      lastRunAt: new Date().toISOString(),
    };
    updated.eligibilityStatus = resolveEligibility(updated.validRunCount);

    // expectedStatus "none" guards against writing over a record a
    // settlement has already advanced past — if this races a settlement
    // that just closed the week, the CAS no-ops and the run stays
    // recorded (above) without corrupting settlement state.
    playerWeek = await kvAllocationStore.upsertPlayerWeekRecord(
      updated,
      base.allocationStatus === "none" ? "none" : base.allocationStatus
    );
  }

  return NextResponse.json({
    accepted: true,
    duplicate: false,
    valid: true,
    weekKey,
    weeklyStats: playerWeek
      ? {
          validRunCount: playerWeek.validRunCount,
          bestScore: playerWeek.bestScore,
          eligibilityStatus: playerWeek.eligibilityStatus,
        }
      : null,
  });
}
