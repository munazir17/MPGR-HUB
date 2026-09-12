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
// Runs on Node (not Edge) since it uses server-side Upstash Redis.

import { NextResponse } from "next/server";
import { protectApiRequest, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import type { Address } from "viem";
import { validateRunResult } from "@/lib/games/mpgr-run/run-validation";
import type { RunResult, RunStats } from "@/lib/games/mpgr-run/run-score";
import { MPGR_RUN_TRACE_VERSION } from "@/lib/games/mpgr-run/input-trace";
import { computeRunScore } from "@/lib/games/mpgr-run/run-score";
import { kvAllocationStore } from "@/lib/reward-allocation/kv-allocation-store";
import { getSessionFromRequest } from "@/lib/auth/session";
import { consumeGameSession, getServerGameSession, heartbeatsCoverDuration } from "@/lib/games/mpgr-run/server-session";
import { verifyAuthoritativeRun } from "@/lib/games/mpgr-run/authoritative-verifier";
import { gameRewardsAreOperatorEnabled, MIN_VALID_RUNS_FOR_ELIGIBILITY } from "@/lib/games/games-reward-config";
import { MPGR_RUN_GAME_ID } from "@/lib/games/mpgr-run/run-config";
import { awardCappedGameXP, getSeasonPoints as getServerSeasonPoints } from "@/lib/rewards/xp-ledger";
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
  result: RunResult;
  inputTrace: {
    version: number;
    events: Array<
      | { type: "jump"; atMs: number }
      | { type: "slide"; atMs: number }
      | { type: "lane"; atMs: number; dir: -1 | 1 }
    >;
  };
}

function isValidShape(value: unknown): value is RewardRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.sessionId !== "string" || body.sessionId.length < 8 || body.sessionId.length > 128) return false;
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
  const guard = await protectApiRequest(request, "game-reward", 10, 60);
  const requestId = guard.requestId;
  if (guard.error) return guard.error;
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), guard.requestId);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body: unknown = parsedBody.value;

  if (!isValidShape(body)) {
    return json(
      { error: "Request must include sessionId and a full RunResult." },
      { status: 400 }
    );
  }

  const auth = getSessionFromRequest(request);
  if (!auth) return json({ error: "Authentication required" }, { status: 401 });
  const wallet = auth.wallet as Address;
  const sessionId = body.sessionId;
  if (sessionId.length > 128) return json({ error: "Invalid game session" }, { status: 400 });
  const gameSession = await getServerGameSession(sessionId);
  if (
    !gameSession ||
    gameSession.wallet.toLowerCase() !== wallet.toLowerCase() ||
    gameSession.gameId !== MPGR_RUN_GAME_ID ||
    gameSession.consumedAt
  ) {
    return json({ error: "Invalid or expired game session" }, { status: 401 });
  }

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
  const sessionAgeMs = Date.now() - Date.parse(gameSession.createdAt);
  if (!Number.isFinite(sessionAgeMs) || resultForValidation.durationMs > sessionAgeMs + 2_000 || sessionAgeMs > 15 * 60 * 1000) {
    return json({ accepted: false, duplicate: false, valid: false, reasons: ["Run duration does not fit the server-issued game session window."] });
  }
  if (!heartbeatsCoverDuration(gameSession, resultForValidation.durationMs)) {
    return json({ accepted: false, duplicate: false, valid: false, reasons: ["Run is missing live session heartbeats spanning the claimed duration."] });
  }

  // Financial settlement requires an independent authoritative attestation.
  // Client-side plausibility checks are never sufficient for real value.
  const authoritative = gameRewardsAreOperatorEnabled()
    ? await verifyAuthoritativeRun({
        sessionId,
        wallet,
        result: resultForValidation,
        inputTrace: body.inputTrace,
        seed: gameSession.seed,
        protocolVersion: gameSession.protocolVersion,
        sessionCreatedAt: gameSession.createdAt,
        sessionExpiresAt: gameSession.expiresAt,
      })
    : { verified: false as const, reason: "Financial game rewards are disabled." };

  if (process.env.GAME_REWARDS_ENABLED === "true" && !authoritative.verified) {
    return json({
      accepted: false,
      duplicate: false,
      valid: false,
      reasons: [authoritative.reason ?? "Authoritative game verification failed."],
    }, { status: 503 });
  }

  const weekKey = getWeekKey(new Date());
  const runRecord: RunRecord = {
    sessionId,
    wallet,
    weekKey,
    submittedAt: new Date().toISOString(),
    serverValidated: validation.valid && authoritative.verified,
    authoritativeProofId: authoritative.verified ? authoritative.proofId : undefined,
    verificationVersion: authoritative.verified ? "authoritative-v1" : undefined,
    result: resultForValidation,
  };

  const insertResult = await kvAllocationStore.putRunRecordIfAbsent(runRecord);

  // A session backs at most one reward decision. Consuming it here (rather
  // than waiting for its natural TTL) prevents any further heartbeat or
  // reward attempt from reusing it, and frees the wallet's concurrent-
  // session slot immediately. This is defense-in-depth on top of the
  // sessionId idempotency key above, which is the primary duplicate guard.
  await consumeGameSession(gameSession).catch((error) => {
    console.error("Failed to mark game session as consumed", error);
  });

  if (!insertResult.inserted) {
    return json({
      accepted: false,
      duplicate: true,
      message: "This run was already recorded.",
    });
  }

  if (!validation.valid) {
    return json({
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

  if (weekIsOpenForContributions && process.env.GAME_REWARDS_ENABLED === "true" && authoritative.verified) {
    const serverSeasonPoints = await getServerSeasonPoints(wallet);
    // This is one atomic Redis operation: two simultaneous valid runs can
    // never both read the same validRunCount and overwrite each other.
    playerWeek = await kvAllocationStore.recordValidatedRun(
      wallet,
      weekKey,
      resultForValidation.score,
      serverSeasonPoints,
      new Date().toISOString(),
      MIN_VALID_RUNS_FOR_ELIGIBILITY,
    );

  }

  // Server-authoritative XP remains available even while financial game
  // rewards are disabled; it is independently idempotent by session ID.
  try { await awardCappedGameXP(wallet, sessionId); }
  catch (error) { console.error("Game XP ledger update failed", error); }

  return json({
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
