import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// components/markets/LiveTape.render.test.ts
//
// Renders the real ticker and locks the requirement that broke: it must
// interleave ONLY the two authoritative sources (official Coinbase
// Tokenized Stocks interleaved with Coinbase wrapped assets), and the
// static "COINBASE · BASE" / "Stocks B20" section labels must be gone.
//
// The tape hook is mocked at the module boundary — this test never
// touches the network and only asserts the rendered markup. JSX is
// expressed with createElement because this repo's vitest config only
// picks up *.test.ts files.

vi.mock("@/hooks/useTape", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTape")>();
  return {
    ...actual,
    useTape: () => ({
      snapshot: {
        asOf: "2026-09-21T12:00:00.000Z",
        chainId: 8453,
        blockNumber: 30_000_000,
        wrapped: [
          { symbol: "cbBTC", name: "Coinbase Wrapped BTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", usd: 86_648.61, change24h: 6.61, source: "DexScreener (Pancakeswap · Base)", stale: false, updatedAt: 1_790_000_000 },
          { symbol: "USDC", name: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usd: 1, change24h: 0.01, source: "DexScreener (Base)", stale: false, updatedAt: 1_790_000_000 },
          { symbol: "cbETH", name: "Coinbase Wrapped Staked ETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", usd: 3_100.5, change24h: 1.1, source: "DexScreener (Base)", stale: false, updatedAt: 1_790_000_000 },
          { symbol: "cbDOGE", name: "Coinbase Wrapped DOGE", address: "0xcbD06E5A2B0C65597161de254AA074E489dEb510", usd: 0.16, change24h: 2.2, source: "DexScreener (Base)", stale: false, updatedAt: 1_790_000_000 },
          { symbol: "cbXRP", name: "Coinbase Wrapped XRP", address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af", usd: 2.4, change24h: -1.4, source: "DexScreener (Base)", stale: false, updatedAt: 1_790_000_000 },
          { symbol: "cbLTC", name: "Coinbase Wrapped LTC", address: "0xcb17C9Db87B595717C857a08468793f5bAb6445F", usd: 96.2, change24h: 0.4, source: "DexScreener (Base)", stale: false, updatedAt: 1_790_000_000 },
          { symbol: "cbADA", name: "Coinbase Wrapped ADA", address: "0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c", usd: 0.52, change24h: 3.3, source: "DexScreener (Base)", stale: false, updatedAt: 1_790_000_000 },
        ],
        stocks: [
          { symbol: "NVDAc", name: "NVIDIA Tokenized Stock (Coinbase)", address: "0xb200000000000000000000f4B7A4d1C7E1b0f6A1c0", usdFeed: 180, usdDex: 181, premiumBps: 55, change24h: 0.5, source: "Chainlink + DexScreener", stale: false, paused: false, feedUpdatedAt: 1_790_000_000, dexUpdatedAt: 1_790_000_000, feedStale: false },
          { symbol: "AAPLc", name: "Apple Tokenized Stock (Coinbase)", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", usdFeed: 339.36, usdDex: 341.05, premiumBps: 50, change24h: 1.54, source: "Chainlink + DexScreener", stale: false, paused: false, feedUpdatedAt: 1_790_000_000, dexUpdatedAt: 1_790_000_000, feedStale: false },
          { symbol: "TSLAc", name: "Tesla Tokenized Stock (Coinbase)", address: "0xb2000000000000000000004d5D1c1a1F1C9F1eA0b2", usdFeed: 420, usdDex: 421, premiumBps: 24, change24h: -0.8, source: "Chainlink + DexScreener", stale: false, paused: false, feedUpdatedAt: 1_790_000_000, dexUpdatedAt: 1_790_000_000, feedStale: false },
        ],
      },
      loading: false,
      error: false,
      refresh: () => {},
    }),
  };
});

const { LiveTape } = await import("./LiveTape");

const html = renderToString(createElement(LiveTape, { onPrepareSwap: () => {} }));

function label(symbol: string): string {
  return `>${symbol}</span>`;
}

function firstIndex(symbol: string): number {
  return html.indexOf(label(symbol));
}

describe("LiveTape ticker", () => {
  it("drops the static section labels completely", () => {
    const upper = html.toUpperCase();
    expect(upper).not.toContain("COINBASE · BASE");
    expect(upper).not.toContain("COINBASE &middot; BASE");
    expect(upper).not.toContain("STOCKS B20");
  });

  it("interleaves tokenized stocks with Coinbase assets, stock first", () => {
    // NVDAc → cbBTC → AAPLc → cbETH → TSLAc → …
    expect(firstIndex("NVDAc")).toBeGreaterThan(-1);
    expect(firstIndex("NVDAc")).toBeLessThan(firstIndex("cbBTC"));
    expect(firstIndex("cbBTC")).toBeLessThan(firstIndex("AAPLc"));
    expect(firstIndex("AAPLc")).toBeLessThan(firstIndex("cbETH"));
    expect(firstIndex("cbETH")).toBeLessThan(firstIndex("TSLAc"));
    expect(firstIndex("cbDOGE")).toBeLessThan(firstIndex("cbXRP"));
    expect(firstIndex("cbADA")).toBeGreaterThan(-1);
  });

  it("never shows a plain stock ticker or an unsupported symbol", () => {
    for (const bare of ["AAPL", "TSLA", "NVDA", "MSFT", "GOOG", "META", "AMZN", "MSTR", "SPCX", "SNDK", "COIN"]) {
      expect(html).not.toContain(label(bare));
    }
    // USDC stays out of the top ticker chips (it is the quote asset);
    // everything else it does — API, agent tools, swaps — is untouched.
    expect(html).not.toContain(label("USDC"));
  });

  it("renders the loop as repeated identical sequences (no jump, no blank)", () => {
    // Two copies of the same deterministic sequence → translateX(-50%),
    // so the loop never shows a jump or a blank gap. (The invisible
    // measurement copy and the sr-only fallback are not part of the
    // animated track.)
    const trackHtml = html.slice(
      html.indexOf("animate-tape-marquee"),
      html.indexOf('class="sr-only"'),
    );
    const sequences = trackHtml.split(label("NVDAc")).length - 1;
    expect(sequences).toBe(2);
    expect(html).toContain("animate-tape-marquee");
    expect(html).toContain("--tape-copies:2");
  });
});
