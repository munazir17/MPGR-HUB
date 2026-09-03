import { describe, expect, it } from "vitest";

import { parseTradeSwapRequest } from "../trade-request";

describe("parseTradeSwapRequest", () => {
  it("accepts a well-formed USDC → WETH request", () => {
    const result = parseTradeSwapRequest({
      fromToken: "USDC",
      toToken: "WETH",
      fromAmount: "1000000",
      taker: "0x2222222222222222222222222222222222222222",
      slippageBps: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slippageBps).toBe(50);
    expect(result.value.from.symbol).toBe("USDC");
  });

  it("rejects same-token swaps, non-atomic amounts, and wild slippage", () => {
    expect(
      parseTradeSwapRequest({
        fromToken: "USDC",
        toToken: "USDC",
        fromAmount: "1000000",
        taker: "0x2222222222222222222222222222222222222222",
      }).ok,
    ).toBe(false);
    expect(
      parseTradeSwapRequest({
        fromToken: "USDC",
        toToken: "ETH",
        fromAmount: "1.5",
        taker: "0x2222222222222222222222222222222222222222",
      }).ok,
    ).toBe(false);
    expect(
      parseTradeSwapRequest({
        fromToken: "USDC",
        toToken: "ETH",
        fromAmount: "1000000",
        taker: "0x2222222222222222222222222222222222222222",
        slippageBps: 5000,
      }).ok,
    ).toBe(false);
  });
});
