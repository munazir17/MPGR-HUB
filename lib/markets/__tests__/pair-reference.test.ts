import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPairReference } from "@/lib/markets/pair-reference";
import { selectReferencePrice } from "@/lib/autonomy/reference-price";
import { findBasePair } from "@/lib/markets/base-pairs";
import { BASE_USDC } from "@/lib/trade/trade-config";
import type { TapePairDetail } from "@/lib/markets/tape-types";

function detail(): TapePairDetail {
  const pair = findBasePair("AAPLc")!;
  return {
    asOf: new Date().toISOString(), chainId: 8453, blockNumber: 1, wrapped: [], stocks: [],
    pair: { ...pair, official: true, status: "live", chainlinkFeed: pair.chainlinkFeed!, company: "Apple", basescanUrl: "", officialListUrl: "", notes: null },
    stockEntry: { symbol: pair.symbol, address: pair.address, name: pair.name, usdFeed: null, usdDex: null, premiumBps: null, change24h: null,
      source: "Chainlink feed unavailable + unavailable", stale: true, feedStale: true, paused: null, feedUpdatedAt: null, dexUpdatedAt: null },
    wrappedEntry: null,
  };
}
const pool = (overrides = {}) => ({ chainId: "base", dexId: "aerodrome", baseToken: { address: findBasePair("AAPLc")!.address },
  quoteToken: { address: BASE_USDC }, priceUsd: "344.53", liquidity: { usd: 1_000_000 }, ...overrides });
const request = (status: number, body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
afterEach(() => vi.restoreAllMocks());

describe("single-pair reference recovery (read-only)", () => {
  it("recovers AAPLc omitted from a successful multi-token batch using only its registered address", async () => {
    const before = detail(); // Observed API shape: both prices null, but the symbol exists.
    const fetchImpl = request(200, { pairs: [pool()] });
    const result = await refreshPairReference(before, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `https://api.dexscreener.com/latest/dex/tokens/${findBasePair("AAPLc")!.address}`,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(result.stockEntry?.usdDex).toBe(344.53);
    expect(result.stockEntry?.usdFeed).toBeNull(); // No fabricated feed or fallback constant.
    expect(result.stockEntry?.stale).toBe(false);
    expect(result.referenceLookup).toMatchObject({ state: "recovered", httpStatus: 200 });
    expect(selectReferencePrice({ ...result, asOf: result.referenceAsOf, stock: result.stockEntry, wrapped: result.wrappedEntry }, "AAPLc"))
      .toMatchObject({ ok: true, referencePrice: "344.53", source: "dexscreener" });
    expect(before.stockEntry?.usdDex).toBeNull(); // Never mutate the cached tape.
    expect(result.asOf).toBe(before.asOf);
  });

  it.each([429, 503])("preserves the real provider HTTP %s with no invented price", async (status) => {
    const result = await refreshPairReference(detail(), request(status, { error: "private upstream detail" }));
    expect(result.stockEntry?.usdDex).toBeNull();
    expect(result.referenceLookup).toMatchObject({ state: "http_error", httpStatus: status });
    expect(JSON.stringify(result.referenceLookup)).not.toContain("private upstream detail");
  });

  it.each([null, {}, { pairs: null }, { pairs: "wrong" }])("rejects malformed upstream response %j", async (body) => {
    const result = await refreshPairReference(detail(), request(200, body));
    expect(result.referenceLookup?.state).toBe("malformed_response");
    expect(result.referenceAsOf).toBeUndefined();
    expect(result.stockEntry?.usdDex).toBeNull();
  });

  it("fails closed on invalid JSON and network errors", async () => {
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>unavailable</html>", { status: 200 }));
    expect((await refreshPairReference(detail(), invalid)).referenceLookup?.state).toBe("malformed_response");
    const down = vi.fn<typeof fetch>().mockRejectedValue(new Error("provider unavailable"));
    expect((await refreshPairReference(detail(), down)).referenceLookup?.state).toBe("network_error");
  });

  it.each([
    [], [pool({ chainId: "ethereum" })], [pool({ baseToken: { address: BASE_USDC } })],
    [pool({ priceUsd: "0" })], [pool({ priceUsd: "NaN" })],
  ].map((pairs) => [pairs]))("refuses absent, wrong-chain, wrong-token, and invalid-price pools", async (pairs) => {
    const result = await refreshPairReference(detail(), request(200, { pairs }));
    expect(result.referenceLookup?.state).toBe("no_matching_price");
    expect(result.stockEntry?.usdDex).toBeNull();
  });

  it("never requests arbitrary/unsupported symbols or mismatched token addresses", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const unsupported = detail();
    unsupported.pair.symbol = "FAKE";
    await refreshPairReference(unsupported, fetchImpl);
    const mismatched = detail();
    mismatched.pair.address = BASE_USDC;
    await refreshPairReference(mismatched, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry a validated fresh Chainlink observation", async () => {
    const before = detail();
    Object.assign(before.stockEntry!, { usdFeed: 347, feedStale: false, stale: false, feedUpdatedAt: Math.floor(Date.now() / 1000) });
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await refreshPairReference(before, fetchImpl)).toBe(before);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it("repairs WETH using the same existing Base DEX reference path, without treating ETH as WETH", async () => {
  const pair = findBasePair("WETH")!;
  expect(pair.address).toBe("0x4200000000000000000000000000000000000006");
  expect(findBasePair("ETH")).toBeNull();
  const before: TapePairDetail = { ...detail(), stockEntry: null,
    pair: { ...detail().pair, symbol: pair.symbol, address: pair.address, kind: "wrapped", chainlinkFeed: null },
    wrappedEntry: { symbol: pair.symbol, address: pair.address, name: pair.name, usd: null, source: "unavailable", stale: true, updatedAt: null, change24h: null } };
  const result = await refreshPairReference(before, request(200, { pairs: [pool({ baseToken: { address: pair.address }, priceUsd: "2500" })] }));
  expect(selectReferencePrice({ ...result, asOf: result.referenceAsOf, stock: null, wrapped: result.wrappedEntry }, "WETH"))
    .toMatchObject({ ok: true, referencePrice: "2500", source: "dexscreener" });
  expect(result.wrappedEntry?.usd).toBe(2500);
});
