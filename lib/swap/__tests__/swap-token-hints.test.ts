import { afterEach, expect, it, vi } from "vitest";
import { fetchSwapTokenHints } from "../swap-token-hints";
const token = { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", name: "Aerodrome Finance" };
afterEach(() => vi.unstubAllGlobals());
it("uses same-origin authenticated bounded search and returns metadata hints only", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ chainId: 8453, tokens: [token] })));
  vi.stubGlobal("fetch", fetcher); expect(await fetchSwapTokenHints("AERO")).toEqual([token]);
  expect(fetcher).toHaveBeenCalledWith("/api/swap/tokens", expect.objectContaining({ method: "POST", credentials: "include", body: JSON.stringify({ query: "AERO", chainId: 8453 }) }));
});
it.each([{ chainId: 1, tokens: [token] }, { chainId: 8453, tokens: [{ ...token, address: "bad" }] }, { chainId: 8453, tokens: [{ ...token, symbol: "<script>" }] }, { chainId: 8453, tokens: Array(21).fill(token) }])("rejects malformed/wrong-network hints %#", async data => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data)))); await expect(fetchSwapTokenHints("AERO")).rejects.toThrow(/Invalid token search/); });
it.each([401, 503])("preserves actionable HTTP %s without importing anything", async status => { vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Token search unavailable" }), { status }))); await expect(fetchSwapTokenHints("AERO")).rejects.toMatchObject({ status }); });
