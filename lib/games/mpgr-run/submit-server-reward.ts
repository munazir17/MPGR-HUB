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

export async function pingGameHeartbeat(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/games/mpgr-run/checkpoint", {
      method: "POST",
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
): Promise<ServerRewardSubmission | null> {
  try {
    const res = await fetch("/api/games/mpgr-run/reward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, result }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ServerRewardSubmission;
  } catch (err) {
    console.warn("submitRunToServer failed (gameplay UI is local-only)", err);
    return null;
  }
}
