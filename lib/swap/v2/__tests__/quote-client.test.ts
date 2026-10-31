// Client-side V2 dispatch.
//
// The safety claim under test: while the gate is dormant, `requestSwapQuoteWithV2`
// is exactly today's V1 call — it never contacts the V2 quote endpoint and never
// changes a quote outcome. Once activated, V2 is primary, V1 is the fallback, and
// an executable V2 response that fails this client's own validation is an ERROR
// rather than a silent route substitution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const mocks = vi.hoisted(() => ({ v1Quote: vi.fn() }));
vi.mock("@/lib/swap/swap-quote", () => ({ requestSwapQuote: mocks.v1Quote }));

import {
  fetchSwapV2Status, requestSwapQuoteWithV2, requestSwapV2Quote,
  __resetSwapV2StatusCacheForTests, SwapV2QuoteError,
} from "../v2-quote-client";
import { __setSwapV2ExecutorForTests, SWAP_V2_SEALED_MANIFEST } from "../deployment";
import { activatedResponse, dormantResponse, sellTokens } from "./activation-fixtures";
import { TAKER } from "./helpers";
import type { ManualSwapInput } from "@/lib/trade/manual-swap";

const TOKENS = [sellTokens.from, sellTokens.to];
const input: ManualSwapInput = {
  fromToken: sellTokens.from.address, toToken: sellTokens.to.address,
  amount: "0.000000000001", slippageBps: 100,
};

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status, headers: { "Content-Type": "application/json" },
  }));

let fetchMock: ReturnType<typeof vi.fn>;
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal("fetch", fetchMock);
}
const calledUrls = () => (fetchMock.mock.calls as [string][]).map((c) => c[0]);

beforeEach(() => { __resetSwapV2StatusCacheForTests(); mocks.v1Quote.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); __setSwapV2ExecutorForTests(null); __resetSwapV2StatusCacheForTests(); });

describe("activation status probe", () => {
  it("reports dormant, and treats any failure as dormant", async () => {
    stubFetch(async () => jsonResponse({ activated: false, chainId: 8453 }));
    expect(await fetchSwapV2Status()).toEqual({ activated: false, chainId: 8453 });

    __resetSwapV2StatusCacheForTests();
    stubFetch(async () => { throw new Error("network down"); });
    expect(await fetchSwapV2Status()).toEqual({ activated: false, chainId: 8453 });

    // A probe that reports the wrong chain must not activate anything.
    __resetSwapV2StatusCacheForTests();
    stubFetch(async () => jsonResponse({ activated: true, chainId: 1 }));
    expect((await fetchSwapV2Status()).activated).toBe(false);

    __resetSwapV2StatusCacheForTests();
    stubFetch(async () => jsonResponse({ activated: true, chainId: 8453 }, 500));
    expect((await fetchSwapV2Status()).activated).toBe(false);
  });

  it("caches the answer so a quote does not cost an extra request every time", async () => {
    stubFetch(async () => jsonResponse({ activated: false, chainId: 8453 }));
    await fetchSwapV2Status();
    await fetchSwapV2Status();
    await fetchSwapV2Status();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("quote dispatch while DORMANT", () => {
  it("is exactly the V1 call and never contacts the V2 quote endpoint", async () => {
    stubFetch(async () => jsonResponse({ activated: false, chainId: 8453 }));
    const v1Proposal = { id: "v1" };
    mocks.v1Quote.mockResolvedValue(v1Proposal);

    const result = await requestSwapQuoteWithV2(input, TAKER, undefined, TOKENS, { fresh: true });

    expect(result).toBe(v1Proposal);
    expect(mocks.v1Quote).toHaveBeenCalledWith(input, TAKER, undefined, TOKENS, { fresh: true });
    // Only the status probe: no V2 quote was requested.
    expect(calledUrls()).toEqual(["/api/swap/v2/status"]);
  });

  it("does not let a broken status probe change the V1 outcome", async () => {
    stubFetch(async () => { throw new Error("probe down"); });
    const v1Proposal = { id: "v1" };
    mocks.v1Quote.mockResolvedValue(v1Proposal);
    expect(await requestSwapQuoteWithV2(input, TAKER, undefined, TOKENS)).toBe(v1Proposal);
    expect(calledUrls().filter((u) => u.includes("/quote"))).toEqual([]);
  });
});

describe("quote dispatch while ACTIVATED", () => {
  beforeEach(() => __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST));

  const activate = (quoteBody: unknown) => stubFetch(async (url) =>
    url.includes("/status") ? jsonResponse({ activated: true, chainId: 8453 }) : jsonResponse(quoteBody));

  it("returns the V2 proposal and never falls back to V1", async () => {
    activate(activatedResponse());
    const p = await requestSwapQuoteWithV2(input, TAKER, undefined, TOKENS);
    expect(p.provider).toBe("mpgr-executor");
    expect(p.transaction!.to.toLowerCase()).toBe(SWAP_V2_SEALED_MANIFEST.executor.toLowerCase());
    expect(mocks.v1Quote).not.toHaveBeenCalled();
  });

  it("falls back to V1 when V2 has no route for the pair", async () => {
    activate(dormantResponse());
    mocks.v1Quote.mockResolvedValue({ id: "v1-fallback" });
    const p = await requestSwapQuoteWithV2(input, TAKER, undefined, TOKENS);
    expect(p).toEqual({ id: "v1-fallback" });
    expect(mocks.v1Quote).toHaveBeenCalledTimes(1);
  });

  it("after a V2 discovery outage, asks V1 and does not fall through to an unfee'd public router", async () => {
    stubFetch(async (url) => url.includes("/status")
      ? jsonResponse({ activated: true, chainId: 8453 })
      : jsonResponse({ code: "DISCOVERY_UNAVAILABLE", error: "Venue quote RPC unavailable" }, 503));
    mocks.v1Quote.mockRejectedValue(new Error("no direct route"));
    await expect(requestSwapQuoteWithV2(input, TAKER, undefined, TOKENS)).rejects.toMatchObject({ code: "DISCOVERY_UNAVAILABLE" });
    expect(mocks.v1Quote).toHaveBeenCalledTimes(1);
    expect(calledUrls().some((url) => String(url).includes("/api/swap/desk"))).toBe(false);
  });

  it("surfaces a V2 liquidity failure as an honest error, not as a V1 quote", async () => {
    // The V2 endpoint answered with an HTTP error, so this must not be retried on V1.
    stubFetch(async (url) => url.includes("/status")
      ? jsonResponse({ activated: true, chainId: 8453 })
      : jsonResponse({ code: "LIQUIDITY_UNAVAILABLE", error: "No liquid V2 route quotes for this Base pair." }, 422));
    await expect(requestSwapQuoteWithV2(input, TAKER, undefined, TOKENS)).rejects.toMatchObject({ code: "LIQUIDITY_UNAVAILABLE" });
    expect(mocks.v1Quote).not.toHaveBeenCalled();
  });

  it("refuses an executable response that fails its own validation, instead of substituting V1", async () => {
    const tampered = activatedResponse();
    tampered.fee = "0"; // fee skipped: the adapter must reject it
    activate(tampered);
    await expect(requestSwapV2Quote(input, TAKER, undefined, TOKENS)).rejects.toBeInstanceOf(SwapV2QuoteError);
    await expect(requestSwapQuoteWithV2(input, TAKER, undefined, TOKENS)).rejects.toThrow(/did not pass this client/i);
    expect(mocks.v1Quote).not.toHaveBeenCalled();
  });

  it("rejects a quote whose slippage differs from what was requested", async () => {
    // Two layers guard this: the adapter cross-checks `slippageBps` and the
    // minimum against the requested value, and `requestSwapV2Quote` re-checks the
    // adapted proposal against the input. The adapter fires first, which is the
    // stronger of the two because it also recomputes the minimum. Either way a
    // mismatched quote can never be returned.
    activate(activatedResponse());
    const mismatched: ManualSwapInput = { ...input, slippageBps: 200 };
    await expect(requestSwapV2Quote(mismatched, TAKER, undefined, TOKENS)).rejects.toBeInstanceOf(SwapV2QuoteError);
    await expect(requestSwapV2Quote(mismatched, TAKER, undefined, TOKENS)).rejects.toThrow(/did not pass this client|does not match the requested/i);
  });

  it("rejects a quote for a different receive token than the one requested", async () => {
    activate(activatedResponse());
    const otherTokens = [sellTokens.from, { ...sellTokens.to, address: "0xc333333333333333333333333333333333333333" as Address }];
    const mismatched: ManualSwapInput = { ...input, toToken: otherTokens[1].address };
    // The intent inspector catches this first and says exactly why: the calldata
    // does not deliver the token the user asked to receive. A substituted receive
    // token can never be returned as a quote.
    await expect(requestSwapV2Quote(mismatched, TAKER, undefined, otherTokens)).rejects.toThrow(/receive token|did not pass this client|does not match the requested/i);
  });

  it("rejects a quote prepared for a different wallet", async () => {
    activate(activatedResponse());
    await expect(requestSwapV2Quote(input, "0xb222222222222222222222222222222222222222" as Address, undefined, TOKENS))
      .rejects.toThrow(/wallet|Connect/i);
  });
});
