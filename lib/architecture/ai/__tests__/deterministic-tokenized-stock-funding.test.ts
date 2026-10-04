import { afterEach, describe, expect, it, vi } from "vitest";

// Regression: "Buy 0.001 AAPLc with ETH" must NOT silently substitute
// USDC as the funding asset and prepare a USDC proposal. Tokenized-stock
// orders currently fund with USDC only, so an explicitly named non-USDC
// funding asset must get a clear unsupported-input response (no
// proposal, no prepare call). An explicit "with USDC" keeps the existing
// flow, and omitting the funding asset keeps byte-identical arguments.

import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";
import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

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
    address: "0x000000000000000000000000000000000000aa",
  };
}

const prepareResult = toolSuccess("tokenized_stock_prepare_order", {
  proposal: { id: "stock_test", requiresConfirmation: true },
});

describe("DeterministicAIProvider tokenized-stock funding asset", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("never substitutes USDC when the user says 'with ETH' — clear unsupported response, no proposal", async () => {
    runTool.mockResolvedValue(prepareResult);

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy 0.001 AAPLc with ETH"),
    );

    // The USDC-funded prepare must never run.
    expect(runTool).not.toHaveBeenCalled();
    expect(response.tradeProposal).toBeUndefined();
    // The user is told the constraint and the safe alternative.
    expect(response.reply).toMatch(/USDC/i);
    expect(response.reply).toMatch(/ETH/i);
    expect(response.reply).toMatch(/nothing was signed/i);
  });

  it("keeps an explicit 'with USDC' on the existing prepare flow, forwarding the funding asset", async () => {
    runTool.mockResolvedValue(prepareResult);

    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Buy 0.001 AAPLc with USDC"),
    );

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      expect.objectContaining({
        symbol: "AAPLc",
        side: "BUY",
        fundingAsset: "USDC",
      }),
      expect.anything(),
    );
    expect(response.tradeProposal).toBeDefined();
  });

  it("keeps the no-funding phrasing byte-identical (no fundingAsset argument added)", async () => {
    runTool.mockResolvedValue(prepareResult);

    await new DeterministicAIProvider().generateReply(
      makeRequest("Buy 0.001 AAPLc"),
    );

    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "AAPLc", amount: "0.001", side: "BUY", amountUnit: "token" },
      expect.anything(),
    );
  });
});
