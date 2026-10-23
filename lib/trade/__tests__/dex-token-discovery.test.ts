import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import {
  DEX_SEARCH_URL,
  discoverDexBaseTokens,
  resetDexDiscoveryCache,
  selectDexMatches,
} from "../dex-token-discovery";
import { resolveSwapToken } from "../trade-token-resolution";
import { resetTokenDiscoveryCache } from "../trade-token-discovery";

const DEEP = "0x1111111111111111111111111111111111111111";
const CLONE = "0x2222222222222222222222222222222222222222";
const rpc = vi.hoisted(() => ({ getCode: vi.fn(), readContract: vi.fn() }));
vi.mock("../trade-public-client", () => ({ getTradePublicClient: () => rpc }));

function pair(address: string, liquidity: number, chainId = "base", symbol = "PEPE") {
  return { chainId, baseToken: { address, symbol, name: "Pepe" }, quoteToken: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" }, liquidity: { usd: liquidity } };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDexDiscoveryCache();
  resetTokenDiscoveryCache();
  rpc.getCode.mockResolvedValue("0x6000");
  rpc.readContract.mockImplementation(async ({ functionName }) => ({ decimals: 18, symbol: "PEPE", name: "Pepe", totalSupply: 1n, balanceOf: 0n })[functionName as "decimals"]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("selectDexMatches", () => {
  it("picks one Base pool only when it dominates liquidity", () => {
    const result = selectDexMatches([pair(DEEP, 500_000), pair(CLONE, 40_000), pair(DEEP, 10_000, "ethereum")], "pepe");
    expect(result).toEqual({ status: "unique", match: { address: getAddress(DEEP), symbol: "PEPE", liquidityUsd: 500_000 } });
  });
  it("does not guess between two real pools", () => {
    const result = selectDexMatches([pair(DEEP, 200_000), pair(CLONE, 80_000)], "PEPE");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.matches.map((token) => token.address)).toEqual([getAddress(DEEP), getAddress(CLONE)]);
  });
  it("refuses a dust pool instead of inventing a trade", () => {
    expect(selectDexMatches([pair(DEEP, 1_200)], "PEPE")).toEqual({ status: "thin", bestUsd: 1_200 });
    expect(selectDexMatches([pair(CLONE, 90_000, "ethereum")], "PEPE")).toEqual({ status: "miss" });
  });
});

describe("resolveSwapToken dex fallback", () => {
  it("resolves a dominant pool through RPC and leaves it unverified", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pairs: [pair(DEEP, 800_000), pair(CLONE, 40_000)] })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveSwapToken("PEPE");
    expect(result).toMatchObject({ ok: true, token: { address: getAddress(DEEP), symbol: "PEPE", verified: false, decimals: 18 } });
    expect(fetchMock.mock.calls[1][0]).toBe(`${DEX_SEARCH_URL}?q=PEPE`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: "error" });
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("http://");
  });
  it("names both contracts when liquidity is split", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pairs: [pair(DEEP, 200_000), pair(CLONE, 90_000)] }))));
    const result = await resolveSwapToken("PEPE");
    expect(result).toMatchObject({ ok: false, error: { code: "TOKEN_AMBIGUOUS" } });
    if (!result.ok) {
      expect(result.error.message).toContain(getAddress(DEEP));
      expect(result.error.message).toContain(getAddress(CLONE));
    }
    expect(rpc.getCode).not.toHaveBeenCalled();
  });
  it("does not prepare a thin pool", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pairs: [pair(DEEP, 900)] }))));
    expect(await resolveSwapToken("PEPE")).toMatchObject({ ok: false, error: { code: "LIQUIDITY_UNAVAILABLE" } });
    expect(rpc.getCode).not.toHaveBeenCalled();
  });
  it("stays not-found when search has no Base pair, and fails closed when search is down", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pairs: null }))));
    expect(await resolveSwapToken("PEPE")).toMatchObject({ ok: false, error: { code: "TOKEN_NOT_FOUND" } });
    resetDexDiscoveryCache();
    resetTokenDiscoveryCache();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tokens: [] })))
      .mockRejectedValueOnce(new Error("secret-key")));
    const down = await resolveSwapToken("PEPE");
    expect(down).toMatchObject({ ok: false, error: { code: "PROVIDER_ERROR" } });
    expect(JSON.stringify(down)).not.toContain("secret-key");
  });
  it("does not search from a URL-shaped ticker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await discoverDexBaseTokens("https://evil.example/PEPE")).toEqual({ status: "miss" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
