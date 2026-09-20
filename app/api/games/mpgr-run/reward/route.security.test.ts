// app/api/games/mpgr-run/reward/route.security.test.ts
//
// Task 7 — regression coverage for the reward route's abuse surface:
//
//   V1: while the operator flags are DISABLED (production default), a run
//       that fails the authoritative replay must NOT grant server XP or
//       weekly competitive facts. Before the fix, a fabricated but
//       plausible result (one that passes the client-style bounds in
//       validateRunResult but cannot be reproduced by the server replay)
//       was accepted and credited — replaying the disabled verification
//       gate.
//   V2: a verified run must persist the authoritative attestation
//       (verificationVersion/authoritativeProofId) into the weekly
//       record — the settlement route requires exactly those fields for
//       financial eligibility. Before the fix they were never written,
//       so the verified→eligible path was unreachable.
//   V4: a malformed inputTrace payload must be rejected with 400 at the
//       request boundary. Before the fix, a missing/invalid inputTrace
//       crashed inside verifyAuthoritativeRun (unhandled TypeError → 500).
//
// Plus guards for the properties that must keep holding: verified runs
// keep working, the flags stay fail-closed, wallet binding comes from the
// session (never the body), replay/duplicate handling, the session
// duration window, heartbeat liveness, and fail-closed behavior when
// Redis is unavailable.
//
// Module boundaries are mocked the same way as route.test.ts; the pure
// validation/replay logic itself is covered in its own test files.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RunResult } from "@/lib/games/mpgr-run/run-score";

const protectApiRequest = vi.fn(async () => ({ requestId: "test-request-id", error: null as Response | null }));
vi.mock("@/lib/api/request-guard", () => ({
  protectApiRequest,
  readJsonBody: async (request: Request) => ({ ok: true, value: await request.json() }),
  withRequestId: (response: Response) => response,
}));

const getSessionFromRequest = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));
vi.mock("@/lib/auth/session-store", () => ({
  authenticateRequest: async () => getSessionFromRequest(),
}));

const getServerGameSession = vi.fn();
const consumeGameSession = vi.fn(async () => undefined);
const heartbeatsCoverDuration = vi.fn(() => true);
vi.mock("@/lib/games/mpgr-run/server-session", () => ({
  getServerGameSession,
  consumeGameSession,
  heartbeatsCoverDuration,
}));

const verifyAuthoritativeRun = vi.fn(async (): Promise<{
  verified: boolean;
  reason?: string;
  proofId?: string;
  computedResult?: RunResult;
}> => ({ verified: false, reason: "Authoritative replay rejected the run." }));
vi.mock("@/lib/games/mpgr-run/authoritative-verifier", () => ({
  verifyAuthoritativeRun,
}));

vi.mock("@/lib/games/games-reward-config", () => ({
  gameRewardsAreOperatorEnabled: () => false,
  MIN_VALID_RUNS_FOR_ELIGIBILITY: 5,
}));

const putRunRecordIfAbsent = vi.fn(async (_record: unknown) => ({ inserted: true, record: undefined as unknown }));
const getWeeklySettlement = vi.fn(async () => null);
const recordValidatedRun = vi.fn(async (
  _wallet: string,
  _weekKey: string,
  _score: number,
  _seasonPoints: number,
  _lastRunAt: string,
  _minRuns: number,
  _verificationVersion?: string,
  _authoritativeProofId?: string,
): Promise<{
  validRunCount: number;
  bestScore: number;
  eligibilityStatus: "pending" | "eligible" | "ineligible";
} | null> => null);
vi.mock("@/lib/reward-allocation/kv-allocation-store", () => ({
  kvAllocationStore: {
    putRunRecordIfAbsent,
    getWeeklySettlement,
    recordValidatedRun,
  },
}));

const awardCappedGameXP = vi.fn(async () => undefined);
vi.mock("@/lib/rewards/xp-ledger", () => ({
  awardCappedGameXP,
  getSeasonPoints: vi.fn(async () => 0),
}));

vi.mock("@/lib/reward-allocation/settlement-engine", () => ({
  getWeekKey: () => "2026-W37",
  resolveEligibility: () => "pending",
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x9999999999999999999999999999999999999999";

// A plausible short run — passes validateRunResult's client-style bounds
// on its own, but is NOT reproducible by the (mocked) replay.
const RESULT: RunResult = {
  distanceMeters: 120,
  durationMs: 10_000,
  coinsCollected: 2,
  gemsCollected: 1,
  xpOrbsCollected: 0,
  keysCollected: 0,
  chestsCollected: 0,
  powerupsCollected: 0,
  obstaclesPassed: 1,
  checkpointsReached: 0,
  bonusScore: 0,
  hitsTaken: 0,
  collided: false,
  maxSpeedTierReached: 1,
  score: 0, // recomputed server-side regardless of what's submitted
};

const VALID_TRACE = { version: 1, events: [{ type: "jump" as const, atMs: 1000 / 60 }] };

function postReward(body: unknown) {
  return new Request("http://localhost/api/games/mpgr-run/reward", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function postRun(sessionId = "session-1234567890", overrides: Record<string, unknown> = {}) {
  return postReward({ sessionId, result: RESULT, inputTrace: VALID_TRACE, ...overrides });
}

function baseSession(overrides: Record<string, unknown> = {}) {
  const created = Date.now() - 10_000;
  return {
    sessionId: "session-1234567890",
    wallet: WALLET,
    gameId: "mpgr-run",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + 15 * 60 * 1000).toISOString(),
    heartbeats: [created],
    ...overrides,
  };
}

async function loadRoute() {
  const { POST } = await import("./route");
  return POST;
}

describe("POST /api/games/mpgr-run/reward — Task 7 hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    protectApiRequest.mockResolvedValue({ requestId: "test-request-id", error: null });
    getSessionFromRequest.mockReturnValue({ wallet: WALLET });
    getServerGameSession.mockResolvedValue(baseSession());
    consumeGameSession.mockResolvedValue(undefined);
    heartbeatsCoverDuration.mockReturnValue(true);
    verifyAuthoritativeRun.mockResolvedValue({ verified: false, reason: "Authoritative replay rejected the run." });
    putRunRecordIfAbsent.mockResolvedValue({ inserted: true, record: undefined });
    recordValidatedRun.mockResolvedValue({ validRunCount: 1, bestScore: 202, eligibilityStatus: "pending" });
  });

  // --- V1: disabled flags must not bypass verification -----------------

  it("does not grant server XP or weekly facts for an unverified run while the flags are disabled", async () => {
    delete process.env.GAME_REWARDS_ENABLED;
    delete process.env.GAME_AUTHORITATIVE_VERIFICATION_ENABLED;
    const POST = await loadRoute();
    const response = await POST(postRun());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accepted).toBe(false);
    expect(body.valid).toBe(false);
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.reasons.length).toBeGreaterThan(0);
    // No reward of any kind for an unverified run.
    expect(awardCappedGameXP).not.toHaveBeenCalled();
    expect(recordValidatedRun).not.toHaveBeenCalled();
    // The attempt is still recorded for audit and the session is single-use.
    expect(putRunRecordIfAbsent).toHaveBeenCalledTimes(1);
    expect(consumeGameSession).toHaveBeenCalledTimes(1);
  });

  it("still grants XP and weekly facts for a VERIFIED run while the flags are disabled", async () => {
    delete process.env.GAME_REWARDS_ENABLED;
    verifyAuthoritativeRun.mockResolvedValue({ verified: true, proofId: "proof-verified" });
    const POST = await loadRoute();
    const response = await POST(postRun());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accepted).toBe(true);
    expect(body.valid).toBe(true);
    expect(awardCappedGameXP).toHaveBeenCalledTimes(1);
    expect(recordValidatedRun).toHaveBeenCalledTimes(1);
    expect(body.weeklyStats).toEqual({ validRunCount: 1, bestScore: 202, eligibilityStatus: "pending" });
  });

  it("stays fail-closed with 503 for an unverified run when GAME_REWARDS_ENABLED is true", async () => {
    process.env.GAME_REWARDS_ENABLED = "true";
    try {
      const POST = await loadRoute();
      const response = await POST(postRun());
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.accepted).toBe(false);
      expect(putRunRecordIfAbsent).not.toHaveBeenCalled();
      expect(consumeGameSession).not.toHaveBeenCalled();
      expect(awardCappedGameXP).not.toHaveBeenCalled();
    } finally {
      delete process.env.GAME_REWARDS_ENABLED;
    }
  });

  // --- V2: verified runs persist the attestation into the weekly record -

  it("persists the authoritative attestation for a verified run so settlement eligibility can match", async () => {
    delete process.env.GAME_REWARDS_ENABLED;
    verifyAuthoritativeRun.mockResolvedValue({ verified: true, proofId: "proof-abc" });
    const POST = await loadRoute();
    const response = await POST(postRun());

    expect(response.status).toBe(200);
    expect(recordValidatedRun).toHaveBeenCalledTimes(1);
    const args = recordValidatedRun.mock.calls[0];
    // wallet, weekKey, score, seasonPoints, lastRunAt, minRuns, verificationVersion, proofId
    expect(args[0]).toBe(WALLET);
    expect(args[1]).toBe("2026-W37");
    expect(args[6]).toBe("authoritative-v1");
    expect(args[7]).toBe("proof-abc");
  });

  // --- V4: malformed inputTrace is a 400, never a crash ----------------

  it.each([
    ["missing inputTrace", (sessionId: string) => postReward({ sessionId, result: RESULT })],
    [
      "inputTrace with wrong version",
      (sessionId: string) => postRun(sessionId, { inputTrace: { version: 2, events: [] } }),
    ],
    [
      "inputTrace with non-array events",
      (sessionId: string) => postRun(sessionId, { inputTrace: { version: 1, events: "nope" } }),
    ],
    [
      "inputTrace event with unknown type",
      (sessionId: string) => postRun(sessionId, { inputTrace: { version: 1, events: [{ type: "teleport", atMs: 1 }] } }),
    ],
    [
      "inputTrace lane event with invalid dir",
      (sessionId: string) => postRun(sessionId, { inputTrace: { version: 1, events: [{ type: "lane", atMs: 1, dir: 2 }] } }),
    ],
    [
      "inputTrace event with non-numeric atMs",
      (sessionId: string) => postRun(sessionId, { inputTrace: { version: 1, events: [{ type: "jump", atMs: "1000" }] } }),
    ],
    [
      "inputTrace event with negative atMs",
      (sessionId: string) => postRun(sessionId, { inputTrace: { version: 1, events: [{ type: "jump", atMs: -5 }] } }),
    ],
    [
      "inputTrace with more than 4096 events",
      (sessionId: string) => postRun(sessionId, { inputTrace: { version: 1, events: Array.from({ length: 4097 }, (_, i) => ({ type: "jump", atMs: i * (1000 / 60) })) } }),
    ],
  ])("rejects %s with 400 before any verification or write", async (_label, build) => {
    const POST = await loadRoute();
    const response = await POST(build("session-1234567890"));
    expect(response.status).toBe(400);
    expect(verifyAuthoritativeRun).not.toHaveBeenCalled();
    expect(putRunRecordIfAbsent).not.toHaveBeenCalled();
    expect(consumeGameSession).not.toHaveBeenCalled();
    expect(awardCappedGameXP).not.toHaveBeenCalled();
  });

  // --- Binding & forgery guards ----------------------------------------

  it("attributes the run to the authenticated wallet, never the body", async () => {
    delete process.env.GAME_REWARDS_ENABLED;
    verifyAuthoritativeRun.mockResolvedValue({ verified: true, proofId: "proof-x" });
    const POST = await loadRoute();
    const response = await POST(postRun("session-1234567890", { walletAddress: OTHER_WALLET }));
    expect(response.status).toBe(200);
    const recorded = putRunRecordIfAbsent.mock.calls[0][0] as { wallet?: string };
    expect(recorded.wallet).toBe(WALLET);
    // No reward field from the body is ever accepted.
    expect(awardCappedGameXP).toHaveBeenCalledTimes(1);
    expect(awardCappedGameXP).toHaveBeenCalledWith(WALLET, "session-1234567890");
  });

  it("ignores forged reward fields in the body (xp/mpgrAmount/rewardId)", async () => {
    delete process.env.GAME_REWARDS_ENABLED;
    verifyAuthoritativeRun.mockResolvedValue({ verified: true, proofId: "proof-y" });
    const POST = await loadRoute();
    const response = await POST(
      postRun("session-1234567890", { xp: 999_999, mpgrAmount: "123456789", rewardId: 42, weight: 1, allocationStatus: "allocated" })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // The response never echoes a reward amount.
    expect(JSON.stringify(body)).not.toContain("123456789");
    expect(awardCappedGameXP).toHaveBeenCalledTimes(1);
    expect(awardCappedGameXP).toHaveBeenCalledWith(WALLET, "session-1234567890");
  });

  it("reports a replayed session as duplicate without re-crediting anything", async () => {
    putRunRecordIfAbsent.mockResolvedValue({ inserted: false, record: {} });
    const POST = await loadRoute();
    const response = await POST(postRun());
    const body = await response.json();
    expect(body.duplicate).toBe(true);
    expect(body.accepted).toBe(false);
    expect(recordValidatedRun).not.toHaveBeenCalled();
    expect(awardCappedGameXP).not.toHaveBeenCalled();
  });

  it("rejects a forged duration that does not fit the server-issued session window", async () => {
    const forged: RunResult = { ...RESULT, durationMs: 600_000 };
    const POST = await loadRoute();
    const response = await POST(postReward({ sessionId: "session-1234567890", result: forged, inputTrace: VALID_TRACE }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accepted).toBe(false);
    expect(awardCappedGameXP).not.toHaveBeenCalled();
    expect(recordValidatedRun).not.toHaveBeenCalled();
  });

  it("rejects a run whose claimed duration is not covered by live heartbeats", async () => {
    heartbeatsCoverDuration.mockReturnValue(false);
    const POST = await loadRoute();
    const response = await POST(postRun());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accepted).toBe(false);
    expect(awardCappedGameXP).not.toHaveBeenCalled();
    expect(recordValidatedRun).not.toHaveBeenCalled();
  });

  it("fails closed when the session store is unavailable (Redis down): no partial writes", async () => {
    getServerGameSession.mockRejectedValue(new Error("redis unavailable"));
    const POST = await loadRoute();
    await expect(POST(postRun())).rejects.toThrow("redis unavailable");
    expect(putRunRecordIfAbsent).not.toHaveBeenCalled();
    expect(consumeGameSession).not.toHaveBeenCalled();
    expect(awardCappedGameXP).not.toHaveBeenCalled();
  });
});
