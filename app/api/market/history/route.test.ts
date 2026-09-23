// app/api/market/history/route.test.ts
//
// The chart history endpoint is allowlist-only: an unknown symbol is a
// 404 and never gets a guessed series, and the series handed to the
// browser always belongs to the symbol that was asked for.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getTapeSnapshot = vi.fn();
vi.mock("@/lib/markets/tape", () => ({
  getTapeSnapshot,
  tapeCacheTtlSeconds: () => 10,
}));

const readChainlinkRoundHistory = vi.fn();
vi.mock("@/lib/trade/tokenized-stocks-onchain", () => ({
  readChainlinkRoundHistory,
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
    {
      symbol: "cbADA",
      name: "Coinbase Wrapped ADA",
      address: "0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c",
      usd: 0.52,
      change24h: 1.2,
      source: "DexScreener (Aerodrome · Base)",
      stale: false,
      updatedAt: 1790000000,
    },
  ],
  stocks: [
    {
      symbol: "AAPLc",
      name: "Apple Tokenized Stock (Coinbase)",
      address: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      usdFeed: 339.36,
      usdDex: 341.05,
      premiumBps: 50,
      change24h: 1.54,
      source: "Chainlink Coinbase equity feed + DexScreener (Aerodrome · Base)",
      stale: false,
      paused: false,
      feedUpdatedAt: 1790000000,
      dexUpdatedAt: 1790000000,
      feedStale: false,
    },
  ],
};

async function call(symbol: string) {
  const { GET } = await import("./route");
  return GET(new Request(`https://mpgrhub.xyz/api/market/history?symbol=${encodeURIComponent(symbol)}`));
}

describe("GET /api/market/history", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getTapeSnapshot.mockResolvedValue(SNAPSHOT);
    readChainlinkRoundHistory.mockResolvedValue([]);
    const { resetTapeHistory, recordTapeSample } = await import("@/lib/markets/tape-history");
    resetTapeHistory();
    // Two real observations for cbADA only.
    recordTapeSample("cbADA", 0.51, 1_790_000_000);
    recordTapeSample("cbADA", 0.52, 1_790_000_010);
  });

  it("404s an unknown symbol without inventing a contract", async () => {
    const response = await call("FAKECOIN");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("UNKNOWN_SYMBOL");
    expect(JSON.stringify(body)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("returns the recorded DEX samples for the requested wrapped asset", async () => {
    const response = await call("cbADA");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.symbol).toBe("cbADA");
    expect(body.kind).toBe("wrapped");
    expect(body.currentUsd).toBe(0.52);
    expect(body.series).toHaveLength(1);
    expect(body.series[0].id).toBe("dex-samples");
    expect(body.series[0].points).toEqual([
      { t: 1_790_000_000, price: 0.51 },
      { t: 1_790_000_010, price: 0.52 },
    ]);
  });

  it("adds the official Chainlink feed rounds for a B20 stock", async () => {
    readChainlinkRoundHistory.mockResolvedValue([
      { t: 1_789_900_000, price: 338.1 },
      { t: 1_789_990_000, price: 339.36 },
    ]);
    const response = await call("AAPLc");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kind).toBe("b20-stock");
    expect(body.series[0].id).toBe("chainlink-feed");
    expect(body.series[0].points).toHaveLength(2);
    // The stock's own series only — never another asset's numbers.
    expect(body.series[0].points.map((point: { price: number }) => point.price)).toEqual([
      338.1, 339.36,
    ]);
  });

  it("falls back to a LABELLED 24h reference until real observations exist", async () => {
    const { resetTapeHistory } = await import("@/lib/markets/tape-history");
    resetTapeHistory();
    const response = await call("cbADA");
    const body = await response.json();
    expect(body.series).toHaveLength(1);
    const reference = body.series[0];
    expect(reference.id).toBe("change24h-reference");
    expect(reference.derived).toBe(true);
    expect(reference.points).toHaveLength(2);
    // 24h-ago endpoint recovered from the source's own published change.
    expect(reference.points[1].price).toBe(0.52);
    expect(reference.points[0].price).toBeCloseTo(0.52 / 1.012, 6);
    expect(reference.points[0].t).toBe(reference.points[1].t - 86_400);
  });

  it("returns no series at all when even the 24h change is missing", async () => {
    const { resetTapeHistory } = await import("@/lib/markets/tape-history");
    resetTapeHistory();
    getTapeSnapshot.mockResolvedValue({
      ...SNAPSHOT,
      wrapped: [{ ...SNAPSHOT.wrapped[0], change24h: null }],
    });
    const response = await call("cbADA");
    const body = await response.json();
    expect(body.series).toEqual([]);
    expect(body.currentUsd).toBe(0.52);
  });
});
