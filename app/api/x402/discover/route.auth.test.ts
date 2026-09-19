// app/api/x402/discover/route.auth.test.ts
//
// This route performs a server-side outbound fetch to a caller-chosen
// URL. Before this change it had no auth, no origin check and no rate
// limit, which made it an open proxy and a free way to burn
// AgentKit/CDP quota.
//
// These tests assert the three gates run BEFORE any outbound work
// happens, and in the right order (origin -> auth -> rate limit), and
// that the authenticated happy path is untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockDiscover, mockGetSession, mockEnforceRateLimit } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockDiscover: vi.fn(),
    mockGetSession: vi.fn(),
    mockEnforceRateLimit: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest: (...args: unknown[]) => mockGetSession(...args),
}));

// Real verifyTrustedOrigin runs; only the Redis-backed limiter is
// stubbed so the test needs no Upstash credentials.
vi.mock("@/lib/api/request-guard", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/api/request-guard")
  >("@/lib/api/request-guard");
  return {
    ...actual,
    enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
  };
});

vi.mock("@/lib/architecture/agentkit", async () => {
  const mapX402 = await vi.importActual<
    typeof import("@/lib/architecture/agentkit/map-x402")
  >("@/lib/architecture/agentkit/map-x402");
  return {
    invokeAgentKitAction: (...args: unknown[]) => mockInvoke(...args),
    isAgentKitErrorPayload: mapX402.isAgentKitErrorPayload,
    mapAgentKitHttpResult: mapX402.mapAgentKitHttpResult,
  };
});

vi.mock("@/lib/x402/x402-discover", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/x402/x402-discover")
  >("@/lib/x402/x402-discover");
  return {
    ...actual,
    discoverX402Resource: (...args: unknown[]) => mockDiscover(...args),
  };
});

const APP_ORIGIN = "https://mpgrhub.xyz";
const SESSION = {
  wallet: "0x1111111111111111111111111111111111111111",
  chainId: 8453,
};

function post(
  body: unknown,
  headers: Record<string, string> = { origin: APP_ORIGIN },
) {
  return new Request(`${APP_ORIGIN}/api/x402/discover`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function agentKit402() {
  mockInvoke.mockResolvedValue({
    ok: true,
    actionName: "make_http_request",
    result: {
      status: "error_402_payment_required",
      acceptablePaymentOptions: [
        {
          scheme: "exact",
          network: "base",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          maxAmountRequired: "1000000",
          payTo: "0x1111111111111111111111111111111111111111",
          resource: "https://api.example.com/paid",
          extra: { name: "USDC", version: "2" },
        },
      ],
    },
  });
}

describe("POST /api/x402/discover — access control", () => {
  let savedAppOrigin: string | undefined;

  beforeEach(() => {
    savedAppOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = APP_ORIGIN;
    mockGetSession.mockReturnValue(SESSION);
    mockEnforceRateLimit.mockResolvedValue(null);
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
    vi.clearAllMocks();
  });

  it("rejects a cross-origin POST with 403 before auth or any outbound call", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ resourceUrl: "https://api.example.com/paid" }, {
      origin: "https://evil.example",
    }));

    expect(res.status).toBe(403);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("rejects a POST with no Origin/Referer at all with 403", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ resourceUrl: "https://api.example.com/paid" }, {}));

    expect(res.status).toBe(403);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request with 401 before any outbound call", async () => {
    mockGetSession.mockReturnValue(null);

    const { POST } = await import("./route");
    const res = await POST(post({ resourceUrl: "https://api.example.com/paid" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("returns the limiter's 429 without doing any outbound work", async () => {
    mockEnforceRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { POST } = await import("./route");
    const res = await POST(post({ resourceUrl: "https://api.example.com/paid" }));

    expect(res.status).toBe(429);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("applies the x402-discover rate-limit bucket at 10 requests / 60s", async () => {
    agentKit402();

    const { POST } = await import("./route");
    await POST(post({ resourceUrl: "https://api.example.com/paid" }));

    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "x402-discover",
      10,
      60,
    );
  });

  it("lets an authenticated, same-origin, in-budget request through (happy path)", async () => {
    agentKit402();

    const { POST } = await import("./route");
    const res = await POST(post({ resourceUrl: "https://api.example.com/paid" }));

    expect(res.status).toBe(200);
    expect(mockInvoke).toHaveBeenCalledWith({
      actionName: "make_http_request",
      args: { url: "https://api.example.com/paid", method: "GET" },
    });

    const body = await res.json();
    expect(body.status).toBe(402);
  });

  it("accepts Referer when a browser omits Origin", async () => {
    agentKit402();

    const { POST } = await import("./route");
    const res = await POST(
      post({ resourceUrl: "https://api.example.com/paid" }, {
        referer: `${APP_ORIGIN}/agent`,
      }),
    );

    expect(res.status).toBe(200);
  });

  it("still blocks SSRF targets for an authenticated caller", async () => {
    const { POST } = await import("./route");

    for (const resourceUrl of [
      "https://localhost/paid",
      "https://[::1]/paid",
      "https://169.254.169.254/latest/meta-data/",
      "https://0.0.0.0/paid",
      "https://100.64.0.1/paid",
    ]) {
      const res = await POST(post({ resourceUrl }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        code: "BLOCKED_HOST",
      });
    }

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
  });
});
