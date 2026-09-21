// app/api/market/tape/route.test.ts
//
// The tape route must: serve the aggregated snapshot with a short cache
// header, rate-limit per IP, and never leak upstream/provider errors.
// The aggregator itself is unit-tested in lib/markets/__tests__/tape.test.ts;
// here it is mocked so the route test never touches the network.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getTapeSnapshot = vi.fn();
const tapeCacheTtlSeconds = vi.fn(() => 10);
vi.mock("@/lib/markets/tape", () => ({
  getTapeSnapshot,
  tapeCacheTtlSeconds,
}));

const checkRateLimit = vi.fn();
vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit,
  clientIpFromRequest: () => "203.0.113.9",
}));

const SNAPSHOT = {
  asOf: "2026-09-21T12:00:00.000Z",
  chainId: 8453,
  blockNumber: 30_000_000,
  wrapped: [
    { symbol: "cbBTC", name: "Coinbase Wrapped BTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", usd: 86648.61, change24h: 6.61, source: "DexScreener (Pancakeswap · Base)", stale: false, updatedAt: 1790000000 },
  ],
  stocks: [
    { symbol: "AAPLc", name: "Apple Tokenized Stock (Coinbase)", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", usdFeed: 339.36, usdDex: 341.05, premiumBps: 50, change24h: 1.54, source: "Chainlink Coinbase equity feed + DexScreener (Aerodrome · Base)", stale: false, paused: false, feedUpdatedAt: 1790000000, dexUpdatedAt: 1790000000, feedStale: false },
  ],
};

describe("GET /api/market/tape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10, retryAfterSeconds: 0 });
  });

  it("returns the aggregated snapshot with a short shared cache header", async () => {
    getTapeSnapshot.mockResolvedValue(SNAPSHOT);
    const { GET } = await import("./route");
    const response = await GET(new Request("https://mpgrhub.xyz/api/market/tape"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=10, stale-while-revalidate=30");
    const body = await response.json();
    expect(body.chainId).toBe(8453);
    expect(body.wrapped[0].symbol).toBe("cbBTC");
    expect(body.stocks[0].symbol).toBe("AAPLc");
    expect(body.stocks[0].premiumBps).toBe(50);
    // No secrets / internals in the response.
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_KEY|SECRET|API_KEY|apiKey|Bearer/i);
  });

  it("rate-limits per IP with a Retry-After", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    const { GET } = await import("./route");
    const response = await GET(new Request("https://mpgrhub.xyz/api/market/tape"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(getTapeSnapshot).not.toHaveBeenCalled();
  });

  it("fails with a generic 502 when the aggregator throws — no stack details", async () => {
    getTapeSnapshot.mockRejectedValue(new Error("RPC endpoint https://secret.internal failed: ECONNREFUSED"));
    const { GET } = await import("./route");
    const response = await GET(new Request("https://mpgrhub.xyz/api/market/tape"));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe("TAPE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("secret.internal");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
