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
  it.each(MANUAL_SWAP_TOKENS.map(t => [t.symbol, t] as const))("%s: every counterasset and both directions agree with registry", (_symbol, token) => {
    for (const other of MANUAL_SWAP_TOKENS) {
      const a = swapPoolAsset(token.address), b = swapPoolAsset(other.address);
      const registered = a !== b && d.tokens.some(t => t.address.toLowerCase() === a) && d.tokens.some(t => t.address.toLowerCase() === b) && d.routes.some(r => ((r.tokenA.toLowerCase() === a && r.tokenB.toLowerCase() === b) || (r.tokenA.toLowerCase() === b && r.tokenB.toLowerCase() === a)) && (r.kind === 1 || r.kind === 2));
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
