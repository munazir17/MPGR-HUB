// app/api/trade/stocks/quote/route.test.ts
//
// CSRF + wallet-session coverage for the B20 prepare route.
// Does NOT mock @/lib/api/request-guard (real verifyTrustedOrigin runs).
// Mocks session read and prepareTokenizedStockSwap so a successful
// prepare can be asserted without hitting chain or signing.

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


const prepareTokenizedStockSwap = vi.fn();
vi.mock("@/lib/trade/tokenized-stock-swap", () => ({
  prepareTokenizedStockSwap,
}));

// Task 3: trade limiter is now async Redis-backed (wallet + IP).
// Mock it so this unit test never touches Redis/network and the
// authenticated success path resolves immediately.
vi.mock("@/lib/trade/trade-rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trade/trade-rate-limit")>();
  return {
    ...actual,
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, retryAfterSeconds: 0 }),
  };
});

const APP_ORIGIN = "https://mpgrhub.xyz";
const SESSION_WALLET = "0xd57b0000000000000000000000000000000095f7";

function postStockQuote(
  headers: Record<string, string> = {},
  body: Record<string, unknown> = {},
  url = `${APP_ORIGIN}/api/trade/stocks/quote`,
) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/trade/stocks/quote — CSRF (real verifyTrustedOrigin)", () => {
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
    const response = await POST(postStockQuote({ origin: APP_ORIGIN }));
    expect(getSessionFromRequest).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
  });

  it("rejects a cross-origin request with 403 before the protected operation runs", async () => {
    const { POST } = await import("./route");
    const response = await POST(postStockQuote({ origin: "https://evil.com" }));
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
    expect(prepareTokenizedStockSwap).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin/Referer at all", async () => {
    const { POST } = await import("./route");
    const response = await POST(postStockQuote());
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("rejects a Vercel deployment hostname in production when APP_ORIGIN is mpgrhub.xyz", async () => {
    const { POST } = await import("./route");
    const vercel = "https://mpgr-hub-ezxs-3z6gjby5g-munazir-razas-projects.vercel.app";
    const response = await POST(
      postStockQuote({ origin: vercel }, { symbol: "AAPLc", amount: "50" }, `${vercel}/api/trade/stocks/quote`),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Cross-site request rejected" });
    expect(getSessionFromRequest).not.toHaveBeenCalled();
    expect(prepareTokenizedStockSwap).not.toHaveBeenCalled();
  });
});

describe("POST /api/trade/stocks/quote — wallet session", () => {
  let savedAppOrigin: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedAppOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = APP_ORIGIN;
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
  });

  it("returns 401 when the session cookie is missing", async () => {
    getSessionFromRequest.mockReturnValue(null);
    const { POST } = await import("./route");
    const response = await POST(
      postStockQuote({ origin: APP_ORIGIN }, { symbol: "AAPLc", amount: "50", side: "BUY" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "Authentication required", code: "AUTH_REQUIRED" });
    expect(prepareTokenizedStockSwap).not.toHaveBeenCalled();
  });

  it("returns 401 when the session is invalid or expired", async () => {
    getSessionFromRequest.mockReturnValue(null);
    const { POST } = await import("./route");
    const response = await POST(
      postStockQuote({ origin: APP_ORIGIN }, { symbol: "AAPLc", amount: "50" }),
    );
    expect(response.status).toBe(401);
    expect(prepareTokenizedStockSwap).not.toHaveBeenCalled();
  });

  it("prepares a quote for an authenticated session and never signs or submits", async () => {
    getSessionFromRequest.mockReturnValue({ wallet: SESSION_WALLET });
    prepareTokenizedStockSwap.mockResolvedValue({
      ok: true,
      proposal: {
        id: "b20_preview",
        kind: "tokenized-stock-swap",
        requiresConfirmation: true,
        executionAvailable: true,
        phase: "idle",
        transaction: { to: "0x1111111111111111111111111111111111111111", data: "0xdead", value: "0" },
      },
    });
    const { POST } = await import("./route");
    const response = await POST(
      postStockQuote({ origin: APP_ORIGIN }, { symbol: "AAPLc", amount: "50", side: "BUY" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(false);
    expect(body.proposal.id).toBe("b20_preview");
    expect(body.proposal.requiresConfirmation).toBe(true);
    expect(prepareTokenizedStockSwap).toHaveBeenCalledTimes(1);
    expect(prepareTokenizedStockSwap).toHaveBeenCalledWith({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "50",
      taker: SESSION_WALLET,
    });
  });
});
