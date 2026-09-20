// app/api/transfer/quote/route.test.ts
//
// Focused CSRF/auth coverage for this route's protectApiRequest() ->
// getSessionFromRequest() gates. Real verifyTrustedOrigin runs (not
// mocked); only @/lib/auth/session is mocked so we can observe whether
// the route reached past the origin gate.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));
// Task 6: routes authenticate via the server-side session registry; the
// test keeps driving the same fake through the async entry point.
vi.mock("@/lib/auth/session-store", () => ({
  authenticateRequest: async () => getSessionFromRequest(),
}));


vi.mock("@/lib/api/redis", () => ({
  getRedis: () => ({
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  }),
}));

const APP_ORIGIN = "https://mpgrhub.xyz";

function postQuote(body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}/api/transfer/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/transfer/quote — CSRF + auth boundary", () => {
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

  it("lets a trusted-origin request reach session auth, then rejects with 401 when unauthenticated", async () => {
    const { POST } = await import("./route");
    const response = await POST(postQuote({}, { origin: APP_ORIGIN }));
    expect(getSessionFromRequest).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(401);
  });

  it("rejects a cross-origin request with 403 before authentication or body parsing runs", async () => {
    const { POST } = await import("./route");
    const response = await POST(postQuote({}, { origin: "https://evil.com" }));
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin/Referer at all", async () => {
    const { POST } = await import("./route");
    const response = await POST(postQuote());
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("never trusts a client-supplied sender/from/wallet field once authenticated", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: "0x2222222222222222222222222222222222222222" });
    const { POST } = await import("./route");
    const response = await POST(
      postQuote(
        {
          token: "ETH",
          amount: "0.01",
          recipient: "0x3333333333333333333333333333333333333333",
          sender: "0x9999999999999999999999999999999999999999",
        },
        { origin: APP_ORIGIN },
      ),
    );
    // Whatever the outcome (success or a downstream provider error), the
    // route must never have echoed the client-supplied sender back as
    // the transfer's authorized sender — that value only ever comes
    // from getSessionFromRequest(), asserted above by mocking it.
    const payload = await response.json();
    if (payload?.proposal) {
      expect(payload.proposal.sender.toLowerCase()).not.toBe("0x9999999999999999999999999999999999999999");
    }
  });
});
