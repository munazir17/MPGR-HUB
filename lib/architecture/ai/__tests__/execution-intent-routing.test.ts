import { afterEach, describe, expect, it, vi } from "vitest";

import { extractBaseSwapIntent } from "@/lib/agent-intelligence";
import { toolSuccess, toolError } from "@/lib/architecture/tools/agent-tool-result";

import type { AIProviderRequest } from "../ai-provider";
import { DeterministicAIProvider } from "../deterministic-ai-provider";

vi.mock("../agent-tool-calling", () => ({
  runRegisteredTool: vi.fn(),
}));

import { runRegisteredTool } from "../agent-tool-calling";

const runTool = vi.mocked(runRegisteredTool);

function makeRequest(prompt: string): AIProviderRequest {
  return {
    prompt,
    agentContext: { isConnected: true } as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
    } as unknown as AIProviderRequest["memoryContext"],
    address: "0x00000000000000000000000000000000000000aa",
  };
}

const swapProposal = {
  id: "swap_prepare",
  requiresConfirmation: true,
  network: "base",
  kind: "swap",
  fromAmount: "5000000",
};

const b20Proposal = {
  id: "b20_prepare",
  requiresConfirmation: true,
  network: "base",
  kind: "tokenized-stock-swap",
  provider: "aerodrome-slipstream",
  fromAmount: "5000000",
};

afterEach(() => {
  runTool.mockReset();
});

/**
 * Explicit BUY/SELL/SWAP commands must reach the LIVE prepare flow
 * (proposal → the existing confirmation modal → the user's wallet
 * signature). Nothing here signs or submits — the tools used are
 * prepare-only, which is asserted directly.
 */
describe("explicit orders route into the live execution flow", () => {
  it("prepares 'Buy 5 USDC of ETH' as USDC → ETH", async () => {
    runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal: swapProposal }));
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy 5 USDC of ETH"),
    );

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0]).toBe("prepare_swap");
    expect(runTool.mock.calls[0][1]).toEqual({
      amount: "5",
      sellSymbol: "USDC",
      buySymbol: "ETH",
    });
    expect(response.tradeProposal).toEqual(swapProposal);
  });

  it("prepares 'Sell 5 USDC of ETH' as USDC → ETH", async () => {
    runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal: swapProposal }));
    await new DeterministicAIProvider().generateReply(makeRequest("Sell 5 USDC of ETH"));

    expect(runTool).toHaveBeenCalledWith(
      "prepare_swap",
      { amount: "5", sellSymbol: "USDC", buySymbol: "ETH" },
      expect.any(Object),
    );
  });

  it("prepares 'Sell my 5 USDC worth of MSTRc' as a SELL of MSTRc (~5 USDC out)", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal: b20Proposal }),
    );
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Sell my 5 USDC worth of MSTRc"),
    );

    // SELL MSTRc with a 5 USDC value target — the pair is MSTRc → USDC,
    // not 5 USDC → MSTRc.
    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "MSTRc", amount: "5", side: "SELL", amountUnit: "usd" },
      expect.any(Object),
    );
    expect(response.tradeProposal).toEqual(b20Proposal);
  });

  it("prepares 'Buy 10 USDC of MSTRc' with the funded side", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal: b20Proposal }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest("Buy 10 USDC of MSTRc"));

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "MSTRc", amount: "10", side: "BUY", amountUnit: "usd" },
      expect.any(Object),
    );
  });

  it("keeps 'Sell 5 MSTRc' a SELL of the stock", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal: b20Proposal }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest("Sell 5 MSTRc"));

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "MSTRc", amount: "5", side: "SELL", amountUnit: "token" },
      expect.any(Object),
    );
  });

  it("sizes 'Sell 5 AAPLc' as 5 SHARES, not $5", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal: b20Proposal }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest("Sell 5 AAPLc"));

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "AAPLc", amount: "5", side: "SELL", amountUnit: "token" },
      expect.any(Object),
    );
  });

  it("sizes 'Sell 0.015 AAPLc' as a fractional share count", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal: b20Proposal }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest("Sell 0.015 AAPLc"));

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "AAPLc", amount: "0.015", side: "SELL", amountUnit: "token" },
      expect.any(Object),
    );
  });

  it("keeps '$5 of my AAPLc' a dollar-denominated sell", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal: b20Proposal }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest("Sell $5 of my AAPLc"));

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "AAPLc", amount: "5", side: "SELL", amountUnit: "usd" },
      expect.any(Object),
    );
  });

  it("reads 'Sell AAPLc of 5 usdc' as a dollar-denominated sell", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal: b20Proposal }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest("Sell AAPLc of 5 usdc"));

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "AAPLc", amount: "5", side: "SELL", amountUnit: "usd" },
      expect.any(Object),
    );
  });

  it("never calls an execute/sign tool for any order", async () => {
    runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal: swapProposal }));
    for (const prompt of [
      "Buy 5 USDC of ETH",
      "Sell 5 USDC of ETH",
      "Sell my 5 USDC worth of MSTRc",
      "Buy 10 USDC of MSTRc",
    ]) {
      runTool.mockClear();
      await new DeterministicAIProvider().generateReply(makeRequest(prompt));
      for (const call of runTool.mock.calls) {
        expect(String(call[0])).not.toMatch(/execute|submit|broadcast|sign/i);
      }
    }
  });
});

describe("unsupported assets can never become executable", () => {
  it.each(["buy 10 USDC of FAKECOIN", "sell 5 SCAMCOIN for USDC"])("discovers unknown symbols without inventing an executable token: %s", async (prompt) => {
    runTool.mockResolvedValue(toolError("trade_prepare_swap", { code: "INVALID_INPUT", message: "No matching Base token was found in the discovery catalog. Provide the exact contract address to check it directly." }));
    const response = await new DeterministicAIProvider().generateReply(makeRequest(prompt));
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0]).toBe("trade_prepare_swap");
    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply).toContain("exact contract address");
  });

  it("still accepts an allowlisted contract address (verified, not guessed)", async () => {
    runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal: swapProposal }));
    const address = "0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c";
    const intent = extractBaseSwapIntent(`swap 10 USDC to ${address}`);

    expect(intent?.buy.symbol).toBe("cbADA");
    expect(intent?.buy.verified).toBe(true);

    await new DeterministicAIProvider().generateReply(
      makeRequest(`swap 10 USDC to ${address}`),
    );
    expect(runTool).toHaveBeenCalledWith(
      "prepare_swap",
      { amount: "10", sellSymbol: "USDC", buySymbol: "cbADA" },
      expect.any(Object),
    );
  });

  it("keeps an unknown address on the existing unverified, CDP-quoted path", async () => {
    const unknown = "0x1234567890abcdef1234567890abcdef12345678";
    const intent = extractBaseSwapIntent(`swap 10 USDC to ${unknown}`);

    // Never silently promoted to a verified/allowlisted asset.
    expect(intent?.buy.verified).toBe(false);
    expect(intent?.buy.address.toLowerCase()).toBe(unknown);
  });
});

describe("research and advice stay research-only", () => {
  it("answers 'should I buy MSTRc?' with research, not a proposal", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_research", {
        report: { kind: "asset", assets: [{ symbol: "MSTRc" }] },
      }),
    );
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("should I buy MSTRc?"),
    );

    expect(runTool).not.toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      expect.anything(),
      expect.anything(),
    );
    expect(runTool).not.toHaveBeenCalledWith(
      "prepare_swap",
      expect.anything(),
      expect.anything(),
    );
    expect(response.tradeProposal).toBeUndefined();
  });

  it("keeps 'Check MSTRc price and oracle' research-only", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_research", {
        report: { kind: "asset", assets: [{ symbol: "MSTRc" }] },
      }),
    );
    await new DeterministicAIProvider().generateReply(
      makeRequest("Check MSTRc price and oracle"),
    );

    expect(runTool.mock.calls.every((call) => call[0] === "tokenized_stock_research")).toBe(true);
  });
});
