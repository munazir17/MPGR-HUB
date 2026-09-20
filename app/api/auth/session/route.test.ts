import { describe, expect, it, vi } from "vitest";

const getSessionFromRequest = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSessionFromRequest }));
// Task 6: routes authenticate via the server-side session registry; the
// test keeps driving the same fake through the async entry point.
vi.mock("@/lib/auth/session-store", () => ({
  authenticateRequest: async () => getSessionFromRequest(),
}));


describe("GET /api/auth/session", () => {
  it("reports no session without ever touching cookies/signing", async () => {
    getSessionFromRequest.mockReturnValue(null);
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/auth/session"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ authenticated: false });
    // Read-only: no Set-Cookie header should ever appear on this route.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reflects an existing valid session's wallet without re-verifying it", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    getSessionFromRequest.mockReturnValue({
      wallet: "0x0000000000000000000000000000000000000001",
      chainId: 8453,
      issuedAt: Math.floor(Date.now() / 1000),
      expiresAt,
      sessionId: "abc",
    });
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/auth/session"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.authenticated).toBe(true);
    expect(data.wallet).toBe("0x0000000000000000000000000000000000000001");
  });
});
