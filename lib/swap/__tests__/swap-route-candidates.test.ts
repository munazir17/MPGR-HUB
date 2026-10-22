import { describe, expect, it } from "vitest";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d } from "@/lib/executor/executor-config";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { isSwapRouteCandidate, swapRouteCandidates, swapRouteKey } from "../swap-route-candidates";

describe("bounded direct search space — compatibility, NOT live liquidity", () => {
  it.each(d.tokens)("$symbol can search every other approved token in either direction without a pair registration", token => {
    for (const other of d.tokens.filter(t => t.address !== token.address)) {
      for (const [from, to] of [[token.address, other.address], [other.address, token.address]]) {
        const routes = swapRouteCandidates(from, to);
        expect(routes).toHaveLength(5); expect(new Set(routes.map(swapRouteKey)).size).toBe(5);
        expect(routes.filter(r => r.kind === 2).map(r => r.poolFee).sort((a,b)=>a!-b!)).toEqual([100,500,3000,10000]);
        expect(routes.every(r => isSwapRouteCandidate(from, to, r))).toBe(true);
      }
    }
  });
  it("ETH aliases WETH only for pool search; wrapping is not a swap", () => {
    expect(swapRouteCandidates(NATIVE_ETH_SENTINEL, d.routes[1].tokenB)).toHaveLength(5);
    expect(swapRouteCandidates(NATIVE_ETH_SENTINEL, d.weth)).toEqual([]);
    expect(swapRouteCandidates(d.weth, d.weth)).toEqual([]);
  });
  it("all 44 unregistered catalog assets remain blocked regardless of discovery", () => {
    const assets = MANUAL_SWAP_TOKENS.filter(t => t.kind !== "native" && !d.tokens.some(a=>a.address.toLowerCase()===t.address.toLowerCase()));
    expect(assets).toHaveLength(44);
    for (const t of assets) expect(swapRouteCandidates(t.address,d.weth)).toEqual([]);
  });
  it("unknown router/module, V4, mismatched tokens, quoter and ambiguous pool-key fields cannot be admitted", () => {
    const [r] = swapRouteCandidates(d.routes[0].tokenA,d.routes[0].tokenB);
    for (const bad of [{...r,kind:3 as const},{...r,router:d.owner},{...r,quoter:d.owner},{...r,tokenA:d.owner},{...r,poolFee:42 as 100},{...r,tickSpacing:99}]) {
      expect(isSwapRouteCandidate(r.tokenA,r.tokenB,bad)).toBe(false);
    }
    const slip=swapRouteCandidates(r.tokenA,r.tokenB).find(x=>x.kind===1)!;
    expect(isSwapRouteCandidate(r.tokenA,r.tokenB,{...slip,poolFee:10 as 100,tickSpacing:999})).toBe(false);
  });
});
