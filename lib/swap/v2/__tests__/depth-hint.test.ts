import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { BASE_USDC, BASE_WETH } from "@/lib/trade/trade-config";
import { depthSubject, fetchPairDepthHint, pairDepthIsThin } from "../depth-hint";

const RNBW = "0xa53887F7e7c1bf5010b8627F1C1ba94fE7a5d6E0" as Address;
const rows = [
  { baseToken: { address: RNBW }, quoteToken: { address: BASE_USDC }, liquidity: { usd: 145_536.65 } },
  { baseToken: { address: RNBW }, quoteToken: { address: BASE_USDC }, liquidity: { usd: 442.78 } },
  { baseToken: { address: RNBW }, quoteToken: { address: "0x0000000000000000000000000000000000000000" }, liquidity: { usd: 105.45 } },
  { baseToken: { address: RNBW }, quoteToken: { address: BASE_WETH }, liquidity: { usd: 49.17 } },
  { baseToken: { address: "0xEF5997c2cf2f6c138196f8A6203afc335206b3c1" }, quoteToken: { address: RNBW }, liquidity: { usd: 1073.37 } },
];

describe("pair depth hint", () => {
  it("treats RNBW/WETH as thin because the USDC book is the deep one", () => {
    expect(depthSubject(RNBW, BASE_WETH)).toBe(RNBW);
    expect(depthSubject(BASE_WETH, RNBW)).toBe(RNBW);
    expect(pairDepthIsThin(rows, RNBW, BASE_WETH)).toBe(true);
    expect(pairDepthIsThin(rows, BASE_WETH, RNBW)).toBe(true);
  });

  it("does not call the deep USDC pair thin, or a hub-to-hub pair", () => {
    expect(pairDepthIsThin(rows, RNBW, BASE_USDC)).toBe(false);
    expect(depthSubject(BASE_USDC, BASE_WETH)).toBeNull();
    expect(pairDepthIsThin(rows, BASE_USDC, BASE_WETH)).toBe(false);
  });

  it("ignores a deep direct book and a dust hub", () => {
    const deepDirect = [{ baseToken: { address: RNBW }, quoteToken: { address: BASE_WETH }, liquidity: { usd: 80_000 } }, { baseToken: { address: RNBW }, quoteToken: { address: BASE_USDC }, liquidity: { usd: 400_000 } }];
    expect(pairDepthIsThin(deepDirect, RNBW, BASE_WETH)).toBe(false);
    const dust = [{ baseToken: { address: RNBW }, quoteToken: { address: BASE_WETH }, liquidity: { usd: 40 } }, { baseToken: { address: RNBW }, quoteToken: { address: BASE_USDC }, liquidity: { usd: 90 } }];
    expect(pairDepthIsThin(dust, RNBW, BASE_WETH)).toBe(false);
  });

  it("fails soft when the indexer does not answer", async () => {
    const fetchImpl = async () => { throw new Error("down"); };
    expect(await fetchPairDepthHint(RNBW, BASE_WETH, fetchImpl as typeof fetch)).toBeNull();
    expect(await fetchPairDepthHint(BASE_WETH, BASE_USDC, fetchImpl as typeof fetch)).toBe(false);
  });
});
