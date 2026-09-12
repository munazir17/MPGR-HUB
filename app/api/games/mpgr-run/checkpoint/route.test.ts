// app/api/games/mpgr-run/checkpoint/route.test.ts
//
// Regression coverage for the checkpoint (heartbeat) route: it must
// require authentication, validate sessionId shape before touching
// storage, and propagate a rejected heartbeat (expired/wrong-wallet/
// wrong-game/consumed session — all collapsed to null by
// recordGameHeartbeat) as 401. Dependencies are mocked at the module
// boundary; recordGameHeartbeat's own game-id/consumed-session logic is
// covered separately in server-session.security.test.ts.

import { describe, expect, it, vi, beforeEach } from "vitest";

const protectApiRequest = vi.fn(async () => ({ requestId: "test-request-id", error: null as Response | null }));
vi.mock("@/lib/api/request-guard", () => ({
  protectApiRequest,
  readJsonBody: async (request: Request) => ({ ok: true, value: await request.json() }),
  withRequestId: (response: Response) => response,
}));

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));

const recordGameHeartbeat = vi.fn();
vi.mock("@/lib/games/mpgr-run/server-session", () => ({
  recordGameHeartbeat,
}));

function postCheckpoint(body: unknown) {
  return new Request("http://localhost/api/games/mpgr-run/checkpoint", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/games/mpgr-run/checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    protectApiRequest.mockResolvedValue({ requestId: "test-request-id", error: null });
  });

  it("rejects unauthenticated requests", async () => {
    getSessionFromRequest.mockReturnValue(null);
    const { POST } = await import("./route");
    const response = await POST(postCheckpoint({ sessionId: "a".repeat(20) }));
    expect(response.status).toBe(401);
    expect(recordGameHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects a malformed session id before calling storage", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: "0x1111111111111111111111111111111111111111" });
    const { POST } = await import("./route");
    const response = await POST(postCheckpoint({ sessionId: "short" }));
    expect(response.status).toBe(400);
    expect(recordGameHeartbeat).not.toHaveBeenCalled();
  });

  it("binds the heartbeat to the mpgr-run game id", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: "0x1111111111111111111111111111111111111111" });
    recordGameHeartbeat.mockResolvedValue({ expiresAt: "2026-01-01T00:00:00.000Z" });
    const { POST } = await import("./route");
    await POST(postCheckpoint({ sessionId: "a".repeat(20) }));
    expect(recordGameHeartbeat).toHaveBeenCalledWith("a".repeat(20), "0x1111111111111111111111111111111111111111", "mpgr-run");
  });

  it("rejects when the session is invalid, expired, wrong-game, or already consumed", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: "0x1111111111111111111111111111111111111111" });
    recordGameHeartbeat.mockResolvedValue(null);
    const { POST } = await import("./route");
    const response = await POST(postCheckpoint({ sessionId: "a".repeat(20) }));
    expect(response.status).toBe(401);
  });
});
