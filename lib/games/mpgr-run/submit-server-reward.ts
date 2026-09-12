import type { RunResult } from "./run-score";
import type { RunInputTrace } from "./input-trace";

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

export async function pingGameHeartbeat(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/games/mpgr-run/checkpoint", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function submitRunToServer(
  _address: string,
  sessionId: string,
  result: RunResult,
  inputTrace: RunInputTrace,
): Promise<ServerRewardSubmission | null> {
  try {
    const res = await fetch("/api/games/mpgr-run/reward", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, result, inputTrace }),
    });
    if (!res.ok) return null;

    const submission = (await res.json()) as ServerRewardSubmission;

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("mpgr-run:weekly-stats-updated", { detail: submission.weeklyStats ?? null }),
      );
      window.dispatchEvent(new CustomEvent("mpgr-xp-updated"));
    }

    return submission;
  } catch (err) {
    console.warn("submitRunToServer failed (gameplay UI is local-only)", err);
    return null;
  }
}
