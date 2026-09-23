// lib/trade/__tests__/instant-swap.test.ts
//
// The tape's one-tap "Prepare swap USDC → <token>" fast path.
//
// It must: refuse anything outside the official allowlist before making
// a request, use the SAME session-bound routes the agent's prepare tool
// uses (B20 → /api/trade/stocks/quote, everything else →
// /api/trade/quote), and collapse duplicate taps into one request.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSTANT_SWAP_AMOUNT_USDC,
  buildInstantSwapPrompt,
  fetchInstantSwapProposal,
  resetInstantSwapCache,
} from "../instant-swap";

const PROPOSAL = { id: "proposal-1", kind: "swap" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchInstantSwapProposal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetInstantSwapCache();
    fetchMock = vi.fn(async () => jsonResponse({ proposal: PROPOSAL }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetInstantSwapCache();
  });

  it("refuses an unknown symbol without any network request", async () => {
    const result = await fetchInstantSwapProposal({ symbol: "FAKECOIN" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_ASSET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses USDC → USDC and published-but-not-live B20 tickers", async () => {
    const stable = await fetchInstantSwapProposal({ symbol: "USDC" });
    expect(stable.ok).toBe(false);
    if (!stable.ok) expect(stable.code).toBe("INVALID_INPUT");

    const notLive = await fetchInstantSwapProposal({ symbol: "COINc" });
    expect(notLive.ok).toBe(false);
    if (!notLive.ok) expect(notLive.code).toBe("UNSUPPORTED_ASSET");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes a live B20 stock through the tokenized-stock quote route", async () => {
    const result = await fetchInstantSwapProposal({ symbol: "AAPLc" });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/trade/stocks/quote");
    expect(JSON.parse(String(init.body))).toEqual({
      symbol: "AAPLc",
      side: "BUY",
      amount: INSTANT_SWAP_AMOUNT_USDC,
    });
  });

  it("routes a wrapped Coinbase asset through the generic swap quote route", async () => {
    const result = await fetchInstantSwapProposal({ symbol: "cbADA" });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/trade/quote");
    expect(JSON.parse(String(init.body))).toEqual({
      fromToken: "USDC",
      toToken: "cbADA",
      amount: INSTANT_SWAP_AMOUNT_USDC,
    });
  });

  it("collapses duplicate taps into a single request for the same pair", async () => {
    const [first, second] = await Promise.all([
      fetchInstantSwapProposal({ symbol: "cbADA" }),
      fetchInstantSwapProposal({ symbol: "cbADA" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
  });

  it("surfaces the route's error and does not cache a failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "No liquidity", code: "LIQUIDITY_UNAVAILABLE" }, 409),
    );
    const failed = await fetchInstantSwapProposal({ symbol: "cbBTC" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("LIQUIDITY_UNAVAILABLE");
      expect(failed.message).toBe("No liquidity");
    }

    // A retry must hit the network again rather than replaying the error.
    const retried = await fetchInstantSwapProposal({ symbol: "cbBTC" });
    expect(retried.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("buildInstantSwapPrompt", () => {
  it("names the pair and the review fields the confirmation modal shows", () => {
    const prompt = buildInstantSwapPrompt("cbADA");
    expect(prompt).toContain("10 USDC to cbADA");
    expect(prompt).toContain("minOut");
    expect(prompt).toContain("route");
    expect(prompt).toContain("price impact");
    expect(prompt).toContain("fees");
  });
});
