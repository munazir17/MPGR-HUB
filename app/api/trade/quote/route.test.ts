// app/api/trade/quote/route.test.ts
//
// Focused CSRF coverage for this route's direct verifyTrustedOrigin()
// call. Does NOT mock @/lib/api/request-guard (real verifyTrustedOrigin
// runs); mocks only @/lib/auth/session to observe whether the route
// reached past the origin gate.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));

const APP_ORIGIN = "https://mpgrhub.xyz";

function postQuote(headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}/api/trade/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({}),
  });
}

describe("POST /api/trade/quote — CSRF (real verifyTrustedOrigin)", () => {
  let savedAppOrigin: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedAppOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = APP_ORIGIN;
    getSessionFromRequest.mockReturnValue(null);
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
  });

  it("lets a trusted-origin request reach the route's own logic (past the origin gate)", async () => {
    const { POST } = await import("./route");
    const response = await POST(postQuote({ origin: APP_ORIGIN }));
    expect(getSessionFromRequest).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
  });

  it("rejects a cross-origin request with 403 before the protected operation runs", async () => {
    const { POST } = await import("./route");
    const response = await POST(postQuote({ origin: "https://evil.com" }));
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin/Referer at all", async () => {
    const { POST } = await import("./route");
    const response = await POST(postQuote());
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });
});
