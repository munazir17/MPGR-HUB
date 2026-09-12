// app/api/games/mpgr-run/session/route.test.ts
//
// Regression coverage for the game-session route's security boundary:
// it must require authentication, and must fail closed (429, not a
// silently-issued session) when a wallet is already at its concurrent
// session cap. Dependencies are mocked at the module boundary, following
// the existing app/api/leaderboard/route.test.ts pattern — this exercises
// the route handler's own decisions, not Redis or the auth cookie format.

import { describe, expect, it, vi, beforeEach } from "vitest";

const protectApiRequest = vi.fn(async () => ({ requestId: "test-request-id", error: null as Response | null }));
vi.mock("@/lib/api/request-guard", () => ({
  protectApiRequest,
  withRequestId: (response: Response) => response,
}));

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));

const createServerGameSession = vi.fn();
class TooManyActiveSessionsError extends Error {}
vi.mock("@/lib/games/mpgr-run/server-session", () => ({
  createServerGameSession,
  TooManyActiveSessionsError,
}));

describe("POST /api/games/mpgr-run/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    protectApiRequest.mockResolvedValue({ requestId: "test-request-id", error: null });
  });

  it("rejects unauthenticated requests before minting a session", async () => {
    getSessionFromRequest.mockReturnValue(null);
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/games/mpgr-run/session", { method: "POST" }));
    expect(response.status).toBe(401);
    expect(createServerGameSession).not.toHaveBeenCalled();
  });

  it("issues a session for an authenticated wallet", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: "0x1111111111111111111111111111111111111111" });
    createServerGameSession.mockResolvedValue({ sessionId: "abc123", expiresAt: "2026-01-01T00:00:00.000Z" });
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/games/mpgr-run/session", { method: "POST" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessionId).toBe("abc123");
  });

  it("fails closed with 429 (not a silently-issued session) once the wallet is at its concurrency cap", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: "0x1111111111111111111111111111111111111111" });
    createServerGameSession.mockRejectedValue(new TooManyActiveSessionsError("too many"));
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/games/mpgr-run/session", { method: "POST" }));
    expect(response.status).toBe(429);
  });
});
