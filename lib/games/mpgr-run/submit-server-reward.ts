// lib/games/mpgr-run/submit-server-reward.ts
//
// Game Rewards Module — client-side call to
// POST /api/games/mpgr-run/reward. Fire-and-forget by design: XP,
// achievements, and the local game-over UI (all handled by
// processRunResult in run-rewards.ts, entirely client-side) must never
// depend on this succeeding. sessionId is the same id used locally, so a
// retry (e.g. calling this again after a network failure) is safe —
// the server enforces idempotency, not this function.

import type { RunResult } from "./run-score";

export interface ServerRewardSubmission {
  accepted: boolean;
  duplicate: boolean;
  valid?: boolean;
  weekKey?: string;
  weeklyStats?: {
    validRunCount: number;
    bestScore: number;
    eligibilityStatus: "pending" | "eligible" | "ineligible";
  } | null;
}

/**
 * Never throws. Returns null on any network/parse failure so callers can
 * treat "couldn't reach the server" identically to "no weekly stats yet"
 * without special-casing errors.
 */
export async function submitRunToServer(
  address: string,
  sessionId: string,
  result: RunResult
): Promise<ServerRewardSubmission | null> {
  try {
    const res = await fetch("/api/games/mpgr-run/reward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, walletAddress: address, result }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ServerRewardSubmission;
  } catch (err) {
    console.warn("submitRunToServer failed (XP/gameplay unaffected)", err);
    return null;
  }
}
