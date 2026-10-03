import { describe, expect, it, vi } from "vitest";

// Fail-closed proof for the exact preview failure: when B20 on-chain
// verification cannot be performed (all Base RPC transports down → null
// decimals), the tokenized-stock quote MUST refuse with PROVIDER_ERROR
// (HTTP 502 at the route) — and must NEVER fabricate decimals, skip
// verification, or return a tradable proposal. A passing-verification
// control shows the flow proceeds normally past the gate, so this test
// pins the gate itself, not an unrelated downstream failure.

import { prepareTokenizedStockSwap } from "../tokenized-stock-swap";
import type { TokenizedStockOnchainState } from "../trade-types";

const VERIFIED: TokenizedStockOnchainState = {
  symbol: "AAPLc",
  name: "Apple tokenized stock",
  decimals: 8,
  totalSupply: "1000000",
  multiplierWad: "1000000000000000000",
  multiplier: "1",
  paused: false,
  chainlinkPriceUsd: "225",
  chainlinkUpdatedAt: 1_700_000_000,
  impliedTokenPriceUsd: "225",
};

const UNVERIFIED: TokenizedStockOnchainState = {
  symbol: null,
  name: null,
  decimals: null,
  totalSupply: null,
  multiplierWad: null,
  multiplier: null,
  paused: null,
  chainlinkPriceUsd: null,
  chainlinkUpdatedAt: null,
  impliedTokenPriceUsd: null,
};

// On-chain reads are the module under simulation; downstream quoting is
// stubbed so a passing-verification run has somewhere deterministic to go.
let onchainState: TokenizedStockOnchainState = UNVERIFIED;
vi.mock("../tokenized-stocks-onchain", () => ({
  readTokenizedStockOnchain: async () => onchainState,
  readB20Decimals: async () => (onchainState.decimals ?? null),
  readChainlinkRoundHistory: async () => [],
}));
vi.mock("../trade-executor-quote", () => ({
  buildExecutorSwapProposal: async () => ({ ok: false as const, supported: false }),
  isExecutorRoutablePair: () => false,
}));
vi.mock("../trade-swap-router", () => ({
  createRoutedSwapQuote: async () => ({
    ok: false as const,
    error: { code: "NO_ROUTE", message: "no route in this test" },
  }),
}));
vi.mock("../trade-price-impact", () => ({
  estimateSwapPriceImpactBps: async () => null,
}));

describe("tokenized stock quote — fail-closed on-chain verification", () => {
  it("refuses with PROVIDER_ERROR (→502) when decimals cannot be verified on-chain", async () => {
    onchainState = UNVERIFIED;
    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "50",
      taker: "0x3333333333333333333333333333333333333333",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROVIDER_ERROR");
      expect(result.error.message).toContain("Could not verify");
    }
  });

  it("control: with verification satisfied the flow proceeds past the gate (fails later at routing, not PROVIDER_ERROR)", async () => {
    onchainState = VERIFIED;
    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "50",
      taker: "0x3333333333333333333333333333333333333333",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Reached the liquidity/routing stage — i.e. the verification gate
      // itself passed. The gate failure above is therefore the thing the
      // 502 was made of, not a downstream artifact.
      expect(result.error.code).not.toBe("PROVIDER_ERROR");
    }
  });
});
