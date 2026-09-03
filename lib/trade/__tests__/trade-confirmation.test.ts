import { describe, expect, it } from "vitest";

import { BASE_USDC, BASE_WETH, PERMIT2_ADDRESS } from "../trade-config";
import { revalidateTradeProposal } from "../trade-confirmation";
import { buildTradeProposal } from "../trade-proposal";
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

function executableQuote(): CdpSwapQuote {
  return {
    liquidityAvailable: true,
    fromToken: BASE_USDC,
    toToken: BASE_WETH,
    fromAmount: "1000000",
    toAmount: "400000000000000",
    minToAmount: "396000000000000",
    issues: { allowance: null, balance: null, simulationIncomplete: false },
    transaction: { to: PERMIT2_ADDRESS, data: "0x1234", value: "0" },
    permit2: null,
  };
}

describe("revalidateTradeProposal", () => {
  it("validates a well-formed executable proposal", () => {
    const built = buildTradeProposal({
      from: usdc,
      to: weth,
      quote: executableQuote(),
      slippageBps: 100,
      taker: TAKER,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = revalidateTradeProposal(built.proposal, TAKER);
    expect(result.state).toBe("VALIDATED");
  });

  it("rejects a research-only proposal (no transaction)", () => {
    const built = buildTradeProposal({
      from: usdc,
      to: weth,
      quote: { ...executableQuote(), liquidityAvailable: false, transaction: null },
      slippageBps: 100,
      taker: TAKER,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = revalidateTradeProposal(built.proposal, TAKER);
    expect(result.state).toBe("VALIDATION_FAILED");
    expect(result.error?.code).toBe("EXECUTION_UNAVAILABLE");
  });

  it("rejects a different connected wallet", () => {
    const built = buildTradeProposal({
      from: usdc,
      to: weth,
      quote: executableQuote(),
      slippageBps: 100,
      taker: TAKER,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const result = revalidateTradeProposal(
      built.proposal,
      "0x3333333333333333333333333333333333333333",
    );
    expect(result.state).toBe("VALIDATION_FAILED");
    expect(result.error?.code).toBe("WALLET_REQUIRED");
  });
});
