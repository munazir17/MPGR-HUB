import { afterEach, describe, expect, it, vi } from "vitest";

import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

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

const proposal = {
  id: "trade_cbada",
  kind: "swap",
  requiresConfirmation: true,
  network: "base",
  chainId: 8453,
  provider: "cdp-trade-api",
  fromAmount: "10000000",
  toAmount: "1000000",
  minToAmount: "990000",
};

describe("DeterministicAIProvider — supported-catalog swap fallback", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("prepares a review-only swap for 'Swap 10 USDC to cbADA'", async () => {
    runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal }));

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Swap 10 USDC to cbADA"),
    );

    expect(runTool).toHaveBeenCalledWith(
      "prepare_swap",
      { amount: "10", sellSymbol: "USDC", buySymbol: "cbADA" },
      expect.any(Object),
    );
    expect(runTool.mock.calls[0]?.[0]).not.toContain("execute");
    expect(response.tradeProposal).toEqual(proposal);
    expect(response.reply).toContain("Nothing is signed or submitted");
  });

  it("resolves a pasted supported contract address instead of rejecting it", async () => {
    runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal }));

    await new DeterministicAIProvider().generateReply(
      makeRequest("Swap 10 USDC to 0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c"),
    );

    expect(runTool).toHaveBeenCalledWith(
      "prepare_swap",
      { amount: "10", sellSymbol: "USDC", buySymbol: "cbADA" },
      expect.any(Object),
    );
  });

  it("passes an unverified raw address through as an address, not a symbol", async () => {
    runTool.mockResolvedValue(toolSuccess("prepare_swap", { proposal }));

    await new DeterministicAIProvider().generateReply(
      makeRequest("swap 5 USDC to 0x1111111111111111111111111111111111111111"),
    );

    expect(runTool).toHaveBeenCalledWith(
      "prepare_swap",
      {
        amount: "5",
        sellSymbol: "USDC",
        buyAddress: "0x1111111111111111111111111111111111111111",
      },
      expect.any(Object),
    );
  });

  it("asks for the amount when a supported pair arrives without one", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Swap cbBTC to cbADA"),
    );

    expect(runTool).not.toHaveBeenCalled();
    expect(response.reply.toLowerCase()).toContain("how much");
    expect(response.tradeProposal).toBeUndefined();
  });

  it("keeps the existing core ETH/USDC quote path untouched", async () => {
    runTool.mockResolvedValue(
      toolSuccess("trade_get_price", { price: { amount: "1" }, provider: "cdp-trade-api" }),
    );

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Swap USDC to ETH"),
    );

    expect(runTool).toHaveBeenCalledWith(
      "trade_get_price",
      { fromToken: "USDC", toToken: "ETH" },
      expect.any(Object),
    );
    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply.toLowerCase()).toContain("quote");
  });

  it("surfaces a grounded prepare failure and never invents a quote", async () => {
    runTool.mockResolvedValue(
      toolError("prepare_swap", {
        code: "DATA_UNAVAILABLE",
        message: "No executable Base DEX route is available for this pair.",
      }),
    );

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Swap 10 USDC to cbDOGE"),
    );

    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply).toContain("No executable Base DEX route");
    expect(response.reply).toContain("Nothing was signed");
  });

  it("leaves unsupported prompts to the normal chat path", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("What is MPGR HUB?"),
    );

    expect(runTool).not.toHaveBeenCalled();
    expect(response.tradeProposal).toBeUndefined();
  });
});
