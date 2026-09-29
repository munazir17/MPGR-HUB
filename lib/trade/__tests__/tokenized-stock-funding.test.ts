import { describe, expect, it, vi, beforeEach } from "vitest";

// Regression + fee-base proof for tokenized-stock funding assets:
//
//   1. fundingAsset "ETH" (or any non-USDC) → UNSUPPORTED_INPUT before
//      ANY quote/fee/execution work — the proposal that used to be
//      silently USDC-substituted is never built.
//   2. fundingAsset "USDC" and NO fundingAsset behave identically and
//      pass the ACTUAL USDC fromAmount into the executor proposal —
//      the 25 bps MPGR fee is computed from that amount (fee = floor(
//      fromAmount × feeBps / 10_000) inside trade-executor-quote), so
//      the fee base is always the selected input asset's amount.

import { prepareTokenizedStockSwap } from "../tokenized-stock-swap";
import { BASE_USDC } from "../trade-config";
import type { TokenizedStockOnchainState } from "../trade-types";

const buildExecutorSwapProposal = vi.fn();
const createRoutedSwapQuote = vi.fn();
const estimateSwapPriceImpactBps = vi.fn();

vi.mock("../tokenized-stocks-onchain", () => ({
  readTokenizedStockOnchain: async () => onchainState,
  readB20Decimals: async () => onchainState.decimals ?? null,
  readChainlinkRoundHistory: async () => [],
}));
vi.mock("../trade-executor-quote", () => ({
  buildExecutorSwapProposal: (...args: unknown[]) => buildExecutorSwapProposal(...args),
  isExecutorRoutablePair: () => true,
}));
vi.mock("../trade-swap-router", () => ({
  createRoutedSwapQuote: (...args: unknown[]) => createRoutedSwapQuote(...args),
}));
vi.mock("../trade-price-impact", () => ({
  estimateSwapPriceImpactBps: (...args: unknown[]) => estimateSwapPriceImpactBps(...args),
}));

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

const TAKER = "0x3333333333333333333333333333333333333333";

let onchainState: TokenizedStockOnchainState = VERIFIED;

beforeEach(() => {
  onchainState = VERIFIED;
  buildExecutorSwapProposal.mockReset();
  createRoutedSwapQuote.mockReset();
  estimateSwapPriceImpactBps.mockReset();
  estimateSwapPriceImpactBps.mockResolvedValue(null);
});

const EXECUTOR_PROPOSAL = {
  id: "exec_test",
  fromAmount: "225000",
  toAmount: "100000",
  minBuyAmount: "99000",
  feeAmount: "562", // floor(225000 × 25 / 10000) — 25 bps of the USDC input
  requiresConfirmation: true,
} as never;

describe("prepareTokenizedStockSwap — explicit funding asset", () => {
  it("refuses ETH funding with UNSUPPORTED_INPUT before any quote or fee work", async () => {
    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "0.001",
      taker: TAKER,
      amountUnit: "token",
      fundingAsset: "ETH",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED_INPUT");
      expect(result.error.message).toContain("ETH");
      expect(result.error.message).toContain("USDC");
      expect(result.error.message).toMatch(/Nothing was signed/i);
    }
    // No proposal machinery ran at all — nothing to silently substitute.
    expect(buildExecutorSwapProposal).not.toHaveBeenCalled();
    expect(createRoutedSwapQuote).not.toHaveBeenCalled();
  });

  it("refuses an unknown funding asset name too (never guesses, never substitutes)", async () => {
    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "0.001",
      taker: TAKER,
      amountUnit: "token",
      fundingAsset: "FAKECOIN",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_INPUT");
    expect(buildExecutorSwapProposal).not.toHaveBeenCalled();
  });

  it("explicit 'with USDC' keeps the flow and passes the ACTUAL USDC fromAmount as the fee base", async () => {
    buildExecutorSwapProposal.mockResolvedValue({ ok: true, proposal: EXECUTOR_PROPOSAL });

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "0.001",
      taker: TAKER,
      amountUnit: "token",
      fundingAsset: "USDC",
    });

    expect(result.ok).toBe(true);
    // 0.001 AAPLc at the verified $225 feed = 0.225 USDC = 225000 atomic
    // (6 decimals) — the executor's 25 bps fee is computed from THIS.
    expect(buildExecutorSwapProposal).toHaveBeenCalledTimes(1);
    const call = buildExecutorSwapProposal.mock.calls[0][0] as {
      from: { address: string; symbol: string; decimals: number };
      to: { address: string };
      fromAmount: string;
    };
    expect(call.from.address.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(call.from.symbol).toBe("USDC");
    expect(call.fromAmount).toBe("225000");
    expect(BigInt(call.fromAmount) * 25n / 10000n).toBe(562n); // the fee base relation
  });

  it("no funding asset (historical callers) behaves byte-identically to explicit USDC", async () => {
    buildExecutorSwapProposal.mockResolvedValue({ ok: true, proposal: EXECUTOR_PROPOSAL });

    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "BUY",
      amountHuman: "0.001",
      taker: TAKER,
      amountUnit: "token",
    });

    expect(result.ok).toBe(true);
    const call = buildExecutorSwapProposal.mock.calls[0][0] as { fromAmount: string; from: { address: string } };
    expect(call.from.address.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(call.fromAmount).toBe("225000");
  });

  it("SELL ignores funding-asset semantics only when the named asset is USDC; non-USDC is still refused", async () => {
    const result = await prepareTokenizedStockSwap({
      symbol: "AAPLc",
      side: "SELL",
      amountHuman: "0.001",
      taker: TAKER,
      amountUnit: "token",
      fundingAsset: "ETH",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_INPUT");
    expect(buildExecutorSwapProposal).not.toHaveBeenCalled();
  });
});
