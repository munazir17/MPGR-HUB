import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TAPE_STOCK_PAIRS, TAPE_WRAPPED_PAIRS } from "@/lib/markets/base-pairs";
import { BASE_USDC } from "@/lib/trade/trade-config";
import {
  buildTapeSnapshot,
  chainlinkAnswerToUsd,
  computePremiumBps,
  getTapeSnapshot,
  groupPairsByToken,
  resetTapeCache,
  selectTapeDexPair,
  type DexScreenerPairLike,
  type TapeSourceDeps,
} from "@/lib/markets/tape";

function makeDeps(overrides: Partial<TapeSourceDeps> = {}): TapeSourceDeps {
  const now = Date.now();
  return {
    nowMs: () => now,
    getBlockNumber: vi.fn(async () => 30_000_000),
    readFeedRound: vi.fn(async () => ({
      answer: "33936000000",
      updatedAt: Math.floor(now / 1000) - 60,
    })),
    readPaused: vi.fn(async () => false),
    fetchDexPairs: vi.fn(async () => [] as DexScreenerPairLike[]),
    ...overrides,
  };
}

describe("selectTapeDexPair", () => {
  const token = "0xb200000000000000000000C2e324d24d7eEcd1fb";

  it("prefers the deepest USDC-quoted Base pool with the token as baseToken", () => {
    const pairs: DexScreenerPairLike[] = [
      {
        chainId: "base",
        dexId: "uniswap",
        baseToken: { address: token },
        quoteToken: { address: BASE_USDC },
        priceUsd: "338.41",
        liquidity: { usd: 56_000 },
      },
      {
        chainId: "base",
        dexId: "aerodrome",
        baseToken: { address: token },
        quoteToken: { address: BASE_USDC },
        priceUsd: "339.36",
        liquidity: { usd: 1_400_000 },
      },
      {
        chainId: "base",
        dexId: "hydrex",
        baseToken: { address: token },
        quoteToken: { address: "0x4200000000000000000000000000000000000006" },
        priceUsd: "338.99",
        liquidity: { usd: 9_000_000 }, // deeper, but not USDC-quoted
      },
    ];
    const best = selectTapeDexPair(pairs, token, BASE_USDC);
    expect(best?.priceUsd).toBe("339.36");
    expect(best?.dexId).toBe("aerodrome");
  });

  it("ignores other chains, quote-side listings, and pools without a USD price", () => {
    expect(
      selectTapeDexPair(
        [
          { chainId: "ethereum", baseToken: { address: token }, priceUsd: "999", liquidity: { usd: 1e9 } },
          { chainId: "base", baseToken: { address: BASE_USDC }, quoteToken: { address: token }, priceUsd: "0.003", liquidity: { usd: 1e9 } },
          { chainId: "base", baseToken: { address: token }, quoteToken: { address: BASE_USDC }, liquidity: { usd: 1e9 } },
        ],
        token,
        BASE_USDC,
      ),
    ).toBeNull();
  });

  it("falls back to the deepest non-USDC pool when no USDC pool exists", () => {
    const best = selectTapeDexPair(
      [
        { chainId: "base", baseToken: { address: token }, quoteToken: { address: "0x4200000000000000000000000000000000000006" }, priceUsd: "338.99", liquidity: { usd: 900 } },
        { chainId: "base", baseToken: { address: token }, quoteToken: { address: "0x4200000000000000000000000000000000000006" }, priceUsd: "339.10", liquidity: { usd: 50_000 } },
      ],
      token,
      BASE_USDC,
    );
    expect(best?.priceUsd).toBe("339.10");
  });
});

describe("computePremiumBps", () => {
  it("computes integer basis points of dex over feed", () => {
    expect(computePremiumBps(100, 101)).toBe(100);
    expect(computePremiumBps(100, 99)).toBe(-100);
    expect(computePremiumBps(339.36, 339.36)).toBe(0);
    expect(computePremiumBps(200, 201.5)).toBe(75);
  });

  it("returns null unless both legs are positive finite numbers", () => {
    expect(computePremiumBps(null, 100)).toBeNull();
    expect(computePremiumBps(100, null)).toBeNull();
    expect(computePremiumBps(0, 100)).toBeNull();
    expect(computePremiumBps(-1, 100)).toBeNull();
    expect(computePremiumBps(100, Number.NaN)).toBeNull();
  });
});

describe("chainlinkAnswerToUsd", () => {
  it("formats 8-decimal answers and rejects junk", () => {
    expect(chainlinkAnswerToUsd("33936000000")).toBeCloseTo(339.36, 8);
    expect(chainlinkAnswerToUsd("0")).toBeNull();
    expect(chainlinkAnswerToUsd("-500000000")).toBeNull();
    expect(chainlinkAnswerToUsd("abc")).toBeNull();
    expect(chainlinkAnswerToUsd("")).toBeNull();
  });
});

describe("buildTapeSnapshot (injected deps, no network)", () => {
  const now = 1_790_000_000_000;
  const aapl = TAPE_STOCK_PAIRS.find((pair) => pair.symbol === "AAPLc")!;
  const nvda = TAPE_STOCK_PAIRS.find((pair) => pair.symbol === "NVDAc")!;
  const cbbtc = TAPE_WRAPPED_PAIRS.find((pair) => pair.symbol === "cbBTC")!;

  function dexPairs(): DexScreenerPairLike[] {
    return [
      {
        chainId: "base",
        dexId: "aerodrome",
        baseToken: { address: aapl.address },
        quoteToken: { address: BASE_USDC },
        priceUsd: "341.05", // ~+50 bps vs 339.36 feed
        priceChange: { h24: 1.54 },
        liquidity: { usd: 1_400_000 },
      },
      {
        chainId: "base",
        dexId: "pancakeswap",
        baseToken: { address: cbbtc.address },
        quoteToken: { address: "0x4200000000000000000000000000000000000006" },
        priceUsd: "86648.61",
        priceChange: { h24: 6.61 },
        liquidity: { usd: 5_900_000 },
      },
    ];
  }

  it("emits every tape entry with source names and honest nulls", async () => {
    const deps = makeDeps({
      now,
      fetchDexPairs: vi.fn(async () => dexPairs()),
      readFeedRound: vi.fn(async () => ({ answer: "33936000000", updatedAt: Math.floor(now / 1000) - 60 })),
    });
    const snapshot = await buildTapeSnapshot(deps);

    expect(snapshot.chainId).toBe(8453);
    expect(snapshot.blockNumber).toBe(30_000_000);
    expect(snapshot.wrapped).toHaveLength(TAPE_WRAPPED_PAIRS.length);
    expect(snapshot.stocks).toHaveLength(TAPE_STOCK_PAIRS.length);

    const btc = snapshot.wrapped.find((entry) => entry.symbol === "cbBTC")!;
    expect(btc.usd).toBeCloseTo(86648.61, 2);
    expect(btc.change24h).toBeCloseTo(6.61, 2);
    expect(btc.stale).toBe(false);
    expect(btc.source).toContain("DexScreener");

    // No source at all → nulls + stale, never invented numbers.
    const doge = snapshot.wrapped.find((entry) => entry.symbol === "cbDOGE")!;
    expect(doge.usd).toBeNull();
    expect(doge.change24h).toBeNull();
    expect(doge.stale).toBe(true);

    const aaplEntry = snapshot.stocks.find((entry) => entry.symbol === "AAPLc")!;
    expect(aaplEntry.usdFeed).toBeCloseTo(339.36, 6);
    expect(aaplEntry.usdDex).toBeCloseTo(341.05, 6);
    expect(aaplEntry.premiumBps).toBeGreaterThan(0);
    expect(aaplEntry.change24h).toBeCloseTo(1.54, 2);
    expect(aaplEntry.paused).toBe(false);
    expect(aaplEntry.stale).toBe(false);
    expect(aaplEntry.feedStale).toBe(false);
    expect(aaplEntry.source).toContain("Chainlink");
  });

  it("flags a frozen feed stale but still returns the last value", async () => {
    const frozenUpdatedAt = Math.floor(now / 1000) - 72 * 3600; // 3 days old (weekend/holiday)
    const deps = makeDeps({
      now,
      fetchDexPairs: vi.fn(async () => []),
      readFeedRound: vi.fn(async () => ({ answer: "33936000000", updatedAt: frozenUpdatedAt })),
    });
    const snapshot = await buildTapeSnapshot(deps);
    const entry = snapshot.stocks.find((s) => s.symbol === "AAPLc")!;
    expect(entry.usdFeed).toBeCloseTo(339.36, 6); // last value kept
    expect(entry.feedStale).toBe(true);
    expect(entry.stale).toBe(true); // no dex leg either
    expect(entry.premiumBps).toBeNull();
    expect(entry.feedUpdatedAt).toBe(frozenUpdatedAt);
  });

  it("surfaces the on-chain pause flag and a failed read as null", async () => {
    const pausedDeps = makeDeps({
      now,
      readPaused: vi.fn(async (token: string) => (token === nvda.address ? true : null)),
    });
    const snapshot = await buildTapeSnapshot(pausedDeps);
    expect(snapshot.stocks.find((s) => s.symbol === "NVDAc")!.paused).toBe(true);
    expect(snapshot.stocks.find((s) => s.symbol === "AAPLc")!.paused).toBeNull();
  });

  it("never invents a 24h change when the source omits it", async () => {
    const deps = makeDeps({
      now,
      fetchDexPairs: vi.fn(async () => [
        {
          chainId: "base",
          baseToken: { address: aapl.address },
          quoteToken: { address: BASE_USDC },
          priceUsd: "341.05",
          priceChange: {},
          liquidity: { usd: 10 },
        },
      ]),
    });
    const snapshot = await buildTapeSnapshot(deps);
    const entry = snapshot.stocks.find((s) => s.symbol === "AAPLc")!;
    expect(entry.usdDex).toBeCloseTo(341.05, 6);
    expect(entry.change24h).toBeNull();
  });
});

describe("getTapeSnapshot cache", () => {
  beforeEach(() => {
    resetTapeCache();
    vi.stubEnv("TAPE_CACHE_TTL_SECONDS", "10");
  });

  afterEach(() => {
    resetTapeCache();
    vi.unstubAllEnvs();
  });

  it("serves one snapshot within the TTL and refreshes after it", async () => {
    let now = 1_790_000_000_000;
    const fetchDexPairs = vi.fn(async () => [] as DexScreenerPairLike[]);
    const deps: TapeSourceDeps = {
      nowMs: () => now,
      getBlockNumber: async () => 1,
      readFeedRound: async () => ({ answer: "100000000", updatedAt: Math.floor(now / 1000) }),
      readPaused: async () => false,
      fetchDexPairs,
    };

    const first = await getTapeSnapshot(deps);
    const second = await getTapeSnapshot(deps);
    expect(second).toBe(first);
    expect(fetchDexPairs).toHaveBeenCalledTimes(1);

    now += 11_000; // past the 10s TTL
    const third = await getTapeSnapshot(deps);
    expect(third).not.toBe(first);
    expect(fetchDexPairs).toHaveBeenCalledTimes(2);
  });

  it("keeps the last snapshot (marked degraded) when a refresh finds no prices", async () => {
    let now = 1_790_000_000_000;
    let healthy = true;
    const aapl = TAPE_STOCK_PAIRS[1]!;
    const deps: TapeSourceDeps = {
      nowMs: () => now,
      getBlockNumber: async () => 1,
      readFeedRound: async () =>
        healthy ? { answer: "33936000000", updatedAt: Math.floor(now / 1000) } : null,
      readPaused: async () => false,
      fetchDexPairs: async () =>
        healthy
          ? [
              {
                chainId: "base",
                baseToken: { address: aapl.address },
                quoteToken: { address: BASE_USDC },
                priceUsd: "340.00",
                liquidity: { usd: 1000 },
              },
            ]
          : [],
    };

    const first = await getTapeSnapshot(deps);
    expect(first.stocks.find((s) => s.symbol === "AAPLc")!.usdFeed).not.toBeNull();

    healthy = false;
    now += 60_000;
    const degraded = await getTapeSnapshot(deps);
    expect(degraded.degraded).toBe(true);
    // Last known values survive the outage instead of blanking the tape.
    expect(degraded.stocks.find((s) => s.symbol === "AAPLc")!.usdFeed).not.toBeNull();
  });
});

describe("groupPairsByToken", () => {
  it("buckets by lowercased baseToken address", () => {
    const grouped = groupPairsByToken([
      { chainId: "base", baseToken: { address: "0xABC" }, priceUsd: "1" },
      { chainId: "base", baseToken: { address: "0xabc" }, priceUsd: "2" },
      { chainId: "base", priceUsd: "3" },
    ]);
    expect(grouped.get("0xabc")).toHaveLength(2);
    expect(grouped.size).toBe(1);
  });
});
