import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchSwapTokenHints, resetSwapTokenHints, SWAP_TOKEN_LIST_URL } from "../swap-token-discovery";
const address = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const row = { chainId: 8453, address, symbol: "AERO", name: "Aerodrome Finance", decimals: 18, logoURI: "https://untrusted.invalid/logo" };
const fetcher = vi.fn();
beforeEach(() => { resetSwapTokenHints(); vi.stubGlobal("fetch", fetcher); fetcher.mockReset().mockResolvedValue(new Response(JSON.stringify([row]))); });
afterEach(() => vi.unstubAllGlobals());
it("exact-address discovery returns hints, never decimals/logos/permission/quotes", async () => {
  const rows = await searchSwapTokenHints("AERO"); expect(rows).toEqual([{ address, symbol: "AERO", name: "Aerodrome Finance" }]);
  expect(fetcher).toHaveBeenCalledWith(SWAP_TOKEN_LIST_URL, expect.objectContaining({ redirect: "error", cache: "no-store" }));
});
it("supports partial names and wrapped symbols without guessing another-chain identity", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify([{ ...row, symbol: "cbZEC", name: "Coinbase Wrapped ZEC" }])));
  expect(await searchSwapTokenHints("ZEC")).toHaveLength(1); expect(await searchSwapTokenHints("BNB")).toEqual([]);
});
it("rejects other chains, invalid addresses, unsafe names/symbols", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify([row, { ...row, address: "bad" }, { ...row, chainId: 1 }, { ...row, symbol: "<script>" }, { ...row, name: "bad\u202e" }])));
  expect(await searchSwapTokenHints("aero")).toHaveLength(1);
});
it("bounds query before any network call", async () => { expect(await searchSwapTokenHints("a")).toEqual([]); expect(await searchSwapTokenHints("a".repeat(65))).toEqual([]); expect(fetcher).not.toHaveBeenCalled(); });
it("deduplicates by address and caches list only, not executable token registration", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify([row, row])));
  expect(await searchSwapTokenHints("aero")).toHaveLength(1); await searchSwapTokenHints("finance"); expect(fetcher).toHaveBeenCalledTimes(1);
});
it("bounds bytes and does not turn network errors into empty success", async () => { fetcher.mockResolvedValue(new Response("x".repeat(2_000_001))); await expect(searchSwapTokenHints("aero")).rejects.toThrow(/limit/); });
it.each([429, 503])("provider %s is an unavailable list, not missing liquidity", async code => { fetcher.mockResolvedValue(new Response("private provider text", { status: code })); await expect(searchSwapTokenHints("aero")).rejects.toThrow(/temporarily unavailable/); });
it("caps response at twenty hints", async () => { fetcher.mockResolvedValue(new Response(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ ...row, address: `0x${(i + 1).toString(16).padStart(40, "0")}` }))))); expect(await searchSwapTokenHints("aero")).toHaveLength(20); });
