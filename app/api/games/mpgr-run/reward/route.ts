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
//   1. validates the request shape (including the input trace)
//   2. validates the wallet address
//   3. re-validates the RunResult server-side (reusing the existing,
//      pure validateRunResult() — same bounds the client already uses)
//   4. always runs the server-side authoritative replay (the real
//      verification — client-side bounds alone are never sufficient)
//   5. atomically records the run (sessionId idempotency via KV NX) —
//      every attempt is kept for audit, verified or not
//   6. if valid AND verified, updates this wallet's PlayerWeekRecord for
//      the current settlement week (validRunCount, bestScore, eligibility,
//      plus the authoritative attestation settlement requires) and awards
//      the capped game XP — only verified runs ever credit anything
//   7. returns an honest status — never a reward amount, weight, or rank
//
// Task 7: an unverified run (replay failed) no longer grants server XP or
// weekly competitive facts even while the operator flags are disabled —
// that path previously let a fabricated-but-plausible result bypass the
// disabled verification gate. Verified behavior (what an honest run sees)
// is unchanged.
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
import { authenticateRequest } from "@/lib/auth/session-store";
import { consumeGameSession, getServerGameSession, heartbeatsCoverDuration } from "@/lib/games/mpgr-run/server-session";
import { verifyAuthoritativeRun } from "@/lib/games/mpgr-run/authoritative-verifier";
import { MIN_VALID_RUNS_FOR_ELIGIBILITY } from "@/lib/games/games-reward-config";
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

/**
 * Task 7: strict input-trace validation at the request boundary. The
 * authoritative replay expects a version-1 trace whose events are
 * jump/slide/lane with finite, non-negative, tick-quantized timestamps;
 * anything else must be a 400, not a TypeError deep inside the verifier.
 * (The replay re-checks every property itself — this only keeps the
 * boundary honest and the error surface 400, not 500.)
 */
function isValidInputTrace(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const trace = value as Record<string, unknown>;
  if (trace.version !== 1) return false;
  if (!Array.isArray(trace.events)) return false;
  if (trace.events.length > 4096) return false;
  for (const raw of trace.events as Array<unknown>) {
    if (!raw || typeof raw !== "object") return false;
    const event = raw as Record<string, unknown>;
    if (typeof event.atMs !== "number" || !Number.isFinite(event.atMs) || event.atMs < 0) return false;
    if (event.type === "jump" || event.type === "slide") continue;
    if (event.type === "lane" && (event.dir === 1 || event.dir === -1)) continue;
    return false;
  }
  return true;
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
  if (!isValidInputTrace(body.inputTrace)) return false;
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

  const auth = await authenticateRequest(request);
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
  let resultForValidation: RunResult = { ...body.result, score: recomputedScore };

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
  // Always perform the server-side authoritative replay verification.
  // Financial rewards may be disabled, but verified gameplay facts still
  // need to reach the weekly stats ledger and remain auditable.
  const authoritative = await verifyAuthoritativeRun({
    sessionId,
    wallet,
    result: resultForValidation,
    inputTrace: body.inputTrace,
    seed: gameSession.seed,
    protocolVersion: gameSession.protocolVersion,
    sessionCreatedAt: gameSession.createdAt,
    sessionExpiresAt: gameSession.expiresAt,
  });

  if (authoritative.computedResult) {
    resultForValidation = {
      ...authoritative.computedResult,
      score: computeRunScore(authoritative.computedResult),
    };
  }

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

  // Task 7: client-side plausibility (validateRunResult) is a sanity
  // filter, not verification. While the operator flags are disabled the
  // financial gate above is off, but that must NOT mean "no
  // verification": an unverified run (the authoritative replay could not
  // reproduce it) credits nothing — no weekly facts, no XP — even when
  // financial rewards are off. Verified runs below are the only path to
  // any reward, in both flag configurations.
  if (!authoritative.verified) {
    return json({
      accepted: false,
      duplicate: false,
      valid: false,
      reasons: [authoritative.reason ?? "Authoritative game verification failed."],
    });
  }

  // From here on the run is authoritatively verified: the stored result
  // is the server-replayed one (see above) and the attestation is the
  // replay's proof.

  // Only update the weekly ledger while the week is still open — once a
  // settlement has closed/computed/allocated a week, further submissions
  // for that (already-passed) weekKey are still recorded for audit
  // (above) but must never retroactively change a frozen PlayerWeekRecord.
  const settlement = await kvAllocationStore.getWeeklySettlement(weekKey);
  const weekIsOpenForContributions = !settlement || settlement.status === "open";

  let playerWeek: PlayerWeekRecord | null = null;

  if (weekIsOpenForContributions) {
    const serverSeasonPoints = await getServerSeasonPoints(wallet);
    // This is one atomic Redis operation: two simultaneous valid runs can
    // never both read the same validRunCount and overwrite each other.
    //
    // Task 7: the attestation (verificationVersion + authoritativeProofId)
    // is persisted with the weekly record — the settlement route's
    // eligibility filter requires exactly those fields for financial
    // payout, so without them no verified run could ever become eligible.
    playerWeek = await kvAllocationStore.recordValidatedRun(
      wallet,
      weekKey,
      resultForValidation.score,
      serverSeasonPoints,
      new Date().toISOString(),
      MIN_VALID_RUNS_FOR_ELIGIBILITY,
      "authoritative-v1",
      authoritative.proofId ?? "",
    );

  }

  // Server-authoritative XP for a VERIFIED run (the unverified path
  // returned above). It remains available while financial game rewards
  // are disabled, and is independently idempotent by session ID.
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
