import { describe, expect, it } from "vitest";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d } from "@/lib/executor/executor-config";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { BASE_USDC, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { swapCounterassets, swapPoolAsset, swapRouteIssue, swapInputError } from "../swap-capability";
import { findBasePairByAddress } from "@/lib/markets/base-pairs";
describe("complete selectable catalog — exact-address registration, not liquidity claims", () => {
  it("covers all 48 catalog assets; 13 route-connected, 35 discovery-only", () => {
    expect(MANUAL_SWAP_TOKENS).toHaveLength(48);
    expect(MANUAL_SWAP_TOKENS.filter(t => swapCounterassets(t.address).length)).toHaveLength(13);
  });
  it.each(MANUAL_SWAP_TOKENS.map(t => [t.symbol, t] as const))("%s: approved identities can search both directions; discovery cannot authorize execution", (_symbol, token) => {
    for (const other of MANUAL_SWAP_TOKENS) {
      const a = swapPoolAsset(token.address), b = swapPoolAsset(other.address);
      const registered = a !== b && d.tokens.some(t => t.address.toLowerCase() === a) && d.tokens.some(t => t.address.toLowerCase() === b);
      expect(swapRouteIssue(token.address, other.address) === null).toBe(registered);
      expect(swapRouteIssue(other.address, token.address) === null).toBe(registered);
      if (registered) expect(swapCounterassets(token.address).map(a => a.toLowerCase())).toContain(other.address.toLowerCase());
    }
  });
  it("not-live contracts stay out of discovery even if registered", () => {
    const hidden = d.tokens.filter(t => findBasePairByAddress(t.address)?.live === false);
    expect(hidden.map(t => t.symbol).sort()).toEqual(["COINc", "CRCLc", "INTCc"]);
    for (const t of hidden) expect(MANUAL_SWAP_TOKENS.some(c => c.address.toLowerCase() === t.address.toLowerCase())).toBe(false);
  });
  it("native ETH aliases only WETH pool identity, not its wallet asset or approval", () => {
    expect(swapRouteIssue(NATIVE_ETH_SENTINEL, d.weth)?.code).toBe("SAME_ASSET");
    expect(swapInputError({ fromToken: NATIVE_ETH_SENTINEL, toToken: d.weth, amount: "1", slippageBps: 100 })).toMatch(/different underlying/);
    expect(swapRouteIssue(NATIVE_ETH_SENTINEL, BASE_USDC)).toBeNull();
  });
});

import { swapCapabilityStatus } from "../swap-capability";
it("metadata validation lets unregistered assets be quoted without claiming liquidity", () => {
  const assets = MANUAL_SWAP_TOKENS.filter(t => !swapCounterassets(t.address).length);
  expect(assets).toHaveLength(35);
  for (const token of assets) {
    expect(swapRouteIssue(token.address, BASE_USDC)?.code).toBe("FEE_ROUTE_UNREGISTERED");
    expect(swapCapabilityStatus(token.address, BASE_USDC, true)).toMatchObject({ code: "QUOTE_REQUIRED", selectable: true, message: expect.stringContaining("Token details checked") });
    expect(swapCapabilityStatus(token.address, BASE_USDC)).toMatchObject({ selectable: true, message: expect.stringContaining("0.25% MPGR fee") });
  }
});
it("registered selection is explicitly unquoted, not execution acceptance", () => {
  expect(swapCapabilityStatus(BASE_USDC, d.weth)).toMatchObject({ code: "REGISTERED_UNQUOTED", selectable: true, message: expect.stringContaining("Get a live quote to check availability") });
});
it("non-registered pairs between approved identities can search, without claiming live liquidity or reversing pay", () => {
  const stock = d.routes[1].tokenB;
  expect(swapCapabilityStatus(stock, d.weth)).toMatchObject({ code: "SEARCH_REQUIRED", selectable: true, message: expect.stringContaining("This pair may need a multi-step route") });
});
