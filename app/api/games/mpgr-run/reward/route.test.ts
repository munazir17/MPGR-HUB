// app/api/games/mpgr-run/reward/route.test.ts
//
// Regression coverage for the reward route's security decisions that
// aren't already covered elsewhere:
//   - a session issued for a different game id is rejected outright
//   - an already-consumed session is rejected outright (single-use)
//   - a valid, first-time submission consumes its session exactly once
//   - financial rewards stay fail-closed when the operator has enabled
//     GAME_REWARDS_ENABLED but authoritative verification did not pass
// validateRunResult/computeRunScore run for real (pure, already covered
// by run-validation.test.ts); storage, auth, and the network verifier
// call are mocked at the module boundary.

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

const getServerGameSession = vi.fn();
const consumeGameSession = vi.fn(async () => undefined);
const heartbeatsCoverDuration = vi.fn(() => true);
vi.mock("@/lib/games/mpgr-run/server-session", () => ({
  getServerGameSession,
  consumeGameSession,
  heartbeatsCoverDuration: (...args: unknown[]) => heartbeatsCoverDuration(...(args as [])),
}));

const verifyAuthoritativeRun = vi.fn(async () => ({ verified: false, reason: "not configured" }));
vi.mock("@/lib/games/mpgr-run/authoritative-verifier", () => ({
  verifyAuthoritativeRun,
}));

const gameRewardsAreOperatorEnabled = vi.fn(() => false);
vi.mock("@/lib/games/games-reward-config", () => ({
  gameRewardsAreOperatorEnabled: () => gameRewardsAreOperatorEnabled(),
  MIN_VALID_RUNS_FOR_ELIGIBILITY: 5,
}));

const putRunRecordIfAbsent = vi.fn(async () => ({ inserted: true }));
const getWeeklySettlement = vi.fn(async () => null);
const recordValidatedRun = vi.fn(async () => null);
vi.mock("@/lib/reward-allocation/kv-allocation-store", () => ({
  kvAllocationStore: {
    putRunRecordIfAbsent,
    getWeeklySettlement,
    recordValidatedRun,
  },
}));

vi.mock("@/lib/rewards/xp-ledger", () => ({
  awardCappedGameXP: vi.fn(async () => undefined),
  getSeasonPoints: vi.fn(async () => 0),
}));

vi.mock("@/lib/reward-allocation/settlement-engine", () => ({
  getWeekKey: () => "2026-W37",
  resolveEligibility: () => "pending",
}));

const WALLET = "0x1111111111111111111111111111111111111111";

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

function postReward(sessionId: string) {
  return new Request("http://localhost/api/games/mpgr-run/reward", {
    method: "POST",
    body: JSON.stringify({ sessionId, result: RESULT }),
  });
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

describe("POST /api/games/mpgr-run/reward", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    protectApiRequest.mockResolvedValue({ requestId: "test-request-id", error: null });
    consumeGameSession.mockResolvedValue(undefined);
    heartbeatsCoverDuration.mockReturnValue(true);
    getSessionFromRequest.mockReturnValue({ wallet: WALLET });
    putRunRecordIfAbsent.mockResolvedValue({ inserted: true });
    gameRewardsAreOperatorEnabled.mockReturnValue(false);
  });

  it("rejects a session that was issued for a different game", async () => {
    getServerGameSession.mockResolvedValue(baseSession({ gameId: "some-other-game" }));
    const { POST } = await import("./route");
    const response = await POST(postReward("session-1234567890"));
    expect(response.status).toBe(401);
    expect(consumeGameSession).not.toHaveBeenCalled();
  });

  it("rejects a session that has already been consumed (single-use)", async () => {
    getServerGameSession.mockResolvedValue(baseSession({ consumedAt: new Date().toISOString() }));
    const { POST } = await import("./route");
    const response = await POST(postReward("session-1234567890"));
    expect(response.status).toBe(401);
    expect(consumeGameSession).not.toHaveBeenCalled();
  });

  it("consumes the session exactly once for a first-time, valid submission", async () => {
    getServerGameSession.mockResolvedValue(baseSession());
    const { POST } = await import("./route");
    const response = await POST(postReward("session-1234567890"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.accepted).toBe(true);
    expect(consumeGameSession).toHaveBeenCalledTimes(1);
  });

  it("stays fail-closed: enabling GAME_REWARDS_ENABLED without a passing authoritative verification never allocates", async () => {
    const originalEnv = process.env.GAME_REWARDS_ENABLED;
    process.env.GAME_REWARDS_ENABLED = "true";
    gameRewardsAreOperatorEnabled.mockReturnValue(true);
    getServerGameSession.mockResolvedValue(baseSession());
    verifyAuthoritativeRun.mockResolvedValue({ verified: false, reason: "Authoritative verifier is unavailable." });
    try {
      const { POST } = await import("./route");
      const response = await POST(postReward("session-1234567890"));
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.accepted).toBe(false);
      expect(recordValidatedRun).not.toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) delete process.env.GAME_REWARDS_ENABLED;
      else process.env.GAME_REWARDS_ENABLED = originalEnv;
    }
  });

  it("reports a duplicate without re-consuming or re-crediting an already-recorded session", async () => {
    getServerGameSession.mockResolvedValue(baseSession());
    putRunRecordIfAbsent.mockResolvedValue({ inserted: false });
    const { POST } = await import("./route");
    const response = await POST(postReward("session-1234567890"));
    const body = await response.json();
    expect(body.duplicate).toBe(true);
    expect(recordValidatedRun).not.toHaveBeenCalled();
  });
});
