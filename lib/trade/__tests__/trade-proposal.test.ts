import { describe, expect, it } from "vitest";
import { getAddress } from "viem";

import { BASE_USDC, BASE_WETH, PERMIT2_ADDRESS } from "../trade-config";
import { buildTradeProposal, isTradeQuoteFresh } from "../trade-proposal";
import type { CdpSwapQuote, TradeTokenRef } from "../trade-types";

const TAKER = "0x2222222222222222222222222222222222222222";

const usdc: TradeTokenRef = {
  address: BASE_USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  kind: "erc20",
  verified: true,
};

const weth: TradeTokenRef = {
  address: BASE_WETH,
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
  kind: "erc20",
  verified: true,
};

function quote(overrides: Partial<CdpSwapQuote> = {}): CdpSwapQuote {
  return {
    liquidityAvailable: true,
    fromToken: BASE_USDC,
    toToken: BASE_WETH,
    fromAmount: "1000000",
    toAmount: "400000000000000",
    minToAmount: "396000000000000",
    issues: {
      allowance: {
        currentAllowance: "0",
        spender: PERMIT2_ADDRESS,
      },
      balance: null,
      simulationIncomplete: false,
    },
    transaction: {
      to: PERMIT2_ADDRESS,
      data: "0x1234",
      value: "0",
    },
    permit2: null,
    ...overrides,
  };
}

describe("buildTradeProposal", () => {
  it("marks a matching CDP quote as executable with Permit2 approval", () => {
    const result = buildTradeProposal({
      from: usdc,
      to: weth,
      quote: quote(),
      slippageBps: 100,
      taker: TAKER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.requiresConfirmation).toBe(true);
    expect(result.proposal.executionAvailable).toBe(true);
    expect(result.proposal.needsPermit2Approval).toBe(true);
    expect(result.proposal.network).toBe("base");
    expect(result.proposal.provider).toBe("cdp-trade-api");
    expect(result.proposal.taker).toBe(getAddress(TAKER));
    expect(result.proposal.displayFromAmount).toContain("USDC");
    expect(result.proposal.postConfirmationSteps.length).toBeGreaterThan(1);
  });

  it("does not offer execution when CDP reports no liquidity", () => {
    const result = buildTradeProposal({
      from: usdc,
      to: weth,
      quote: quote({ liquidityAvailable: false, transaction: null }),
      slippageBps: 100,
      taker: TAKER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.executionAvailable).toBe(false);
    expect(result.proposal.warnings.some((w) => /liquidity/i.test(w))).toBe(true);
  });

  it("labels tokenized-stock swaps separately", () => {
    const aapl: TradeTokenRef = {
      address: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      symbol: "AAPLc",
      name: "Apple Tokenized Stock (Coinbase)",
      decimals: 18,
      kind: "b20-tokenized-stock",
      verified: true,
    };
    const result = buildTradeProposal({
      from: usdc,
      to: aapl,
      quote: quote({ toToken: aapl.address }),
      slippageBps: 100,
      taker: TAKER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.kind).toBe("tokenized-stock-swap");
  });

  it("isTradeQuoteFresh respects the 30s window", () => {
    const result = buildTradeProposal({
      from: usdc,
      to: weth,
      quote: quote(),
      slippageBps: 100,
      taker: TAKER,
      quotedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isTradeQuoteFresh(result.proposal, Date.parse("2026-01-01T00:00:10.000Z"))).toBe(true);
    expect(isTradeQuoteFresh(result.proposal, Date.parse("2026-01-01T00:01:00.000Z"))).toBe(false);
  });
});
