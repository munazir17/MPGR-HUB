// app/api/market/pair/route.test.ts
//
// Allowlist-only pair lookup: known symbols resolve to their official
// contract + explorer link, unknown symbols are rejected with 404 and
// never answered with a guessed address.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getTapeSnapshot = vi.fn();
vi.mock("@/lib/markets/tape", () => ({
  getTapeSnapshot,
  tapeCacheTtlSeconds: () => 10,
}));

vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 })),
  clientIpFromRequest: () => "203.0.113.9",
}));

const SNAPSHOT = {
  asOf: "2026-09-21T12:00:00.000Z",
  chainId: 8453,
  blockNumber: 30_000_000,
  wrapped: [
    { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usd: 1.0, change24h: 0.01, source: "DexScreener (Base)", stale: false, updatedAt: 1790000000 },
  ],
  stocks: [
    { symbol: "AAPLc", name: "Apple Tokenized Stock (Coinbase)", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", usdFeed: 339.36, usdDex: 341.05, premiumBps: 50, change24h: 1.54, source: "Chainlink + DexScreener", stale: false, paused: false, feedUpdatedAt: 1790000000, dexUpdatedAt: 1790000000, feedStale: false },
  ],
};

describe("GET /api/market/pair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTapeSnapshot.mockResolvedValue(SNAPSHOT);
  });

  it("returns the official AAPLc contract, feed leg and basescan link", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("https://mpgrhub.xyz/api/market/pair?symbol=AAPLc"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pair.symbol).toBe("AAPLc");
    expect(body.pair.official).toBe(true);
    expect(body.pair.address.toLowerCase()).toBe("0xb200000000000000000000c2e324d24d7eecd1fb");
    expect(body.pair.basescanUrl).toBe(
      "https://basescan.org/token/0xb200000000000000000000C2e324d24d7eEcd1fb",
    );
    expect(body.pair.officialListUrl).toContain("docs.base.org");
    expect(body.stockEntry.premiumBps).toBe(50);
    expect(body.pair.chainlinkFeed.toLowerCase()).toBe(
      "0x787f13dEa48Db0897CbCDD985de77809D837F988".toLowerCase(),
    );
  });

  it("resolves underlying tickers (AAPL → AAPLc) and wrapped assets", async () => {
    const { GET } = await import("./route");
    const viaUnderlying = await GET(new Request("https://mpgrhub.xyz/api/market/pair?symbol=AAPL"));
    expect(viaUnderlying.status).toBe(200);
    expect((await viaUnderlying.json()).pair.symbol).toBe("AAPLc");

    const usdc = await GET(new Request("https://mpgrhub.xyz/api/market/pair?symbol=USDC"));
    expect(usdc.status).toBe(200);
    const usdcBody = await usdc.json();
    expect(usdcBody.pair.kind).toBe("stable");
    expect(usdcBody.wrappedEntry.symbol).toBe("USDC");
    expect(usdcBody.stockEntry).toBeNull();
  });

  it("rejects unknown symbols and look-alike tickers with 404", async () => {
    const { GET } = await import("./route");
    for (const symbol of ["FOOc", "bNVDA", "cbUSDC", "0xb200000000000000000000000000000000000001", ""]) {
      const response = await GET(
        new Request(`https://mpgrhub.xyz/api/market/pair?symbol=${encodeURIComponent(symbol)}`),
      );
      expect(response.status, `symbol ${symbol || "(empty)"}`).toBe(404);
      const body = await response.json();
      expect(body.code).toBe("UNKNOWN_SYMBOL");
    }
    expect(getTapeSnapshot).not.toHaveBeenCalled();
  });
});
