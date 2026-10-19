import { describe, expect, it } from "vitest";
import { selectReferencePrice } from "../reference-price";
import { checkAutonomyTarget } from "../chat-draft";

const NOW = Date.parse("2026-10-14T17:00:00Z");
const seconds = NOW / 1000;
const address = checkAutonomyTarget("AAPLc").address!;
function observation() {
  return {
    pair: { symbol: "AAPLc", address, official: true, live: true },
    asOf: new Date(NOW).toISOString(), chainId: 8453, degraded: false,
    stock: { symbol: "AAPLc", address, usdFeed: 347 as number | null, usdDex: 348 as number | null,
      stale: false, feedStale: false, feedUpdatedAt: seconds - 60, dexUpdatedAt: seconds - 10 },
    wrapped: null,
  };
}

describe("validated conditional reference price", () => {
  it("uses a positive fresh Chainlink observation from the registered AAPLc address", () => {
    expect(selectReferencePrice(observation(), "AAPLc", NOW)).toEqual({ ok: true, referencePrice: "347", source: "chainlink" });
  });
  it("uses a fresh live DEX observation when the feed is absent or frozen", () => {
    const data = observation();
    data.stock.feedStale = true;
    data.stock.feedUpdatedAt = seconds - 10 * 86_400;
    expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: true, referencePrice: "348", source: "dexscreener" });
    data.stock.usdFeed = null;
    expect(selectReferencePrice(data, "AAPLc", NOW).ok).toBe(true);
  });
  it("does not let a zero/negative feed mask a valid DEX price", () => {
    const data = observation();
    data.stock.usdFeed = 0;
    expect(selectReferencePrice(data, "AAPLc", NOW)).toMatchObject({ ok: true, source: "dexscreener" });
  });
  it("refuses absent sources rather than calling a valid symbol unsupported", () => {
    const data = observation();
    data.stock.usdFeed = null;
    data.stock.usdDex = null;
    data.stock.feedStale = true;
    data.stock.stale = true;
    expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: false, code: "PRICE_UNAVAILABLE" });
  });
  it.each([null, {}, { stockEntry: { usdFeed: 347 } }, { ...observation(), stock: { ...observation().stock, usdFeed: "347" } }])(
    "fails closed on malformed/incorrect API projection %j", (data) => {
      expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: false, code: "MALFORMED_PRICE_RESPONSE" });
    },
  );
  it("rejects unsupported symbols and mismatched pair/entry identities", () => {
    expect(selectReferencePrice(observation(), "FAKE", NOW)).toEqual({ ok: false, code: "UNSUPPORTED_SYMBOL" });
    const data = observation();
    data.pair.symbol = "NVDAc";
    expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: false, code: "PAIR_MISMATCH" });
    data.pair.symbol = "AAPLc";
    data.stock.address = "0x0000000000000000000000000000000000000001";
    expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: false, code: "PAIR_MISMATCH" });
  });
  it("rejects stale/degraded snapshots even if they contain positive numbers", () => {
    const data = observation();
    data.degraded = true;
    expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: false, code: "STALE_PRICE" });
    data.degraded = false;
    data.asOf = new Date(NOW - 300_000).toISOString();
    expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: false, code: "STALE_PRICE" });
  });
  it("a freshly served snapshot never re-dates an old DEX observation", () => {
    const data = observation();
    data.stock.feedStale = true;
    data.stock.dexUpdatedAt = seconds - 3600;
    expect(selectReferencePrice(data, "AAPLc", NOW)).toEqual({ ok: false, code: "STALE_PRICE" });
  });
});
