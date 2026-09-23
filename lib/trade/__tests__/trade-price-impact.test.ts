// lib/trade/__tests__/trade-price-impact.test.ts
//
// Price impact is only ever computed from the app's own trusted tape
// prices. Every missing leg must produce null ("not reported") instead of
// a fabricated percentage.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getTapeSnapshot = vi.fn();
vi.mock("@/lib/markets/tape", () => ({
  getTapeSnapshot,
}));

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBADA = "0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c";
const AAPLC = "0xb200000000000000000000C2e324d24d7eEcd1fb";

function snapshot() {
  return {
    asOf: "2026-09-21T12:00:00.000Z",
    chainId: 8453,
    blockNumber: 1,
    wrapped: [
      {
        symbol: "USDC",
        name: "USD Coin",
        address: USDC,
        usd: 1,
        change24h: 0,
        source: "DexScreener (Base)",
        stale: false,
        updatedAt: 1,
      },
      {
        symbol: "cbADA",
        name: "Coinbase Wrapped ADA",
        address: CBADA,
        usd: 0.5,
        change24h: 0,
        source: "DexScreener (Aerodrome · Base)",
        stale: false,
        updatedAt: 1,
      },
    ],
    stocks: [
      {
        symbol: "AAPLc",
        name: "Apple Tokenized Stock (Coinbase)",
        address: AAPLC,
        usdFeed: 300,
        usdDex: 303,
        premiumBps: 100,
        change24h: 0,
        source: "Chainlink + DexScreener",
        stale: false,
        paused: false,
        feedUpdatedAt: 1,
        dexUpdatedAt: 1,
        feedStale: false,
      },
    ],
  };
}

describe("estimateSwapPriceImpactBps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTapeSnapshot.mockResolvedValue(snapshot());
  });

  it("reports the signed deviation of the execution price from mid", async () => {
    const { estimateSwapPriceImpactBps } = await import("../trade-price-impact");
    // 10 USDC (6dp) → 19 cbADA (6dp): execution 1.9 cbADA/USDC vs mid 2.
    const impact = await estimateSwapPriceImpactBps({
      fromAddress: USDC,
      toAddress: CBADA,
      amounts: {
        fromAmount: "10000000",
        toAmount: "19000000",
        fromDecimals: 6,
        toDecimals: 6,
      },
    });
    expect(impact).toBe(500);
  });

  it("uses the DEX leg of a tokenized stock as its reference price", async () => {
    const { estimateSwapPriceImpactBps } = await import("../trade-price-impact");
    // 100 USDC (6dp) → 0.330033 AAPLc (18dp): execution 303.3¢…  vs mid 303.
    const impact = await estimateSwapPriceImpactBps({
      fromAddress: USDC,
      toAddress: AAPLC,
      amounts: {
        fromAmount: "100000000",
        toAmount: "330033000000000000",
        fromDecimals: 6,
        toDecimals: 18,
      },
    });
    // Slightly better than mid → positive, and small.
    expect(impact).not.toBeNull();
    expect(impact!).toBeLessThan(5);
  });

  it("returns null when either leg has no live trusted price", async () => {
    const { estimateSwapPriceImpactBps } = await import("../trade-price-impact");
    getTapeSnapshot.mockResolvedValue({ ...snapshot(), wrapped: [], stocks: [] });
    const impact = await estimateSwapPriceImpactBps({
      fromAddress: USDC,
      toAddress: CBADA,
      amounts: {
        fromAmount: "10000000",
        toAmount: "19000000",
        fromDecimals: 6,
        toDecimals: 6,
      },
    });
    expect(impact).toBeNull();
  });

  it("never touches the tape for a token outside the allowlist", async () => {
    const { estimateSwapPriceImpactBps } = await import("../trade-price-impact");
    const impact = await estimateSwapPriceImpactBps({
      fromAddress: USDC,
      toAddress: "0x1111111111111111111111111111111111111111",
      amounts: {
        fromAmount: "10000000",
        toAmount: "19000000",
        fromDecimals: 6,
        toDecimals: 6,
      },
    });
    expect(impact).toBeNull();
    expect(getTapeSnapshot).not.toHaveBeenCalled();
  });

  it("survives a tape failure by reporting nothing", async () => {
    const { estimateSwapPriceImpactBps } = await import("../trade-price-impact");
    getTapeSnapshot.mockRejectedValue(new Error("TAPE_UNAVAILABLE"));
    const impact = await estimateSwapPriceImpactBps({
      fromAddress: USDC,
      toAddress: CBADA,
      amounts: {
        fromAmount: "10000000",
        toAmount: "19000000",
        fromDecimals: 6,
        toDecimals: 6,
      },
    });
    expect(impact).toBeNull();
  });
});
