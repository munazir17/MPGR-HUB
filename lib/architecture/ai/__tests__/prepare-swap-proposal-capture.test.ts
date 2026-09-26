import { afterEach, describe, expect, it, vi } from "vitest";

import { runToolCallingLoop } from "../agent-tool-calling";
import { captureTradeProposal } from "../tool-execution-service";
import type { AIProviderRequest } from "../ai-provider";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

// Regression: `prepare_swap` (the Base Stocks Agent's allowlisted swap
// tool) returns the same review-only TradeProposal shape as
// trade_prepare_swap. Before this fix its proposal was silently dropped,
// so a prepared USDC → cbADA / cbBTC / wrapped-asset swap never rendered
// a proposal card and could never reach the confirmation modal.

const proposal = {
  id: "trade_usdc_cbada",
  kind: "swap",
  network: "base",
  chainId: 8453,
  provider: "cdp-trade-api",
  taker: "0x00000000000000000000000000000000000000aa",
  fromAmount: "10000000",
  toAmount: "2000000",
  minToAmount: "1980000",
  executionAvailable: true,
  requiresConfirmation: true,
} as const;

function makeRequest(prompt: string): AIProviderRequest {
  return {
    prompt,
    agentContext: { isConnected: true } as unknown as AIProviderRequest["agentContext"],
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

describe("trade proposal capture", () => {
  it("captures prepare_swap proposals like the other prepare tools", () => {
    expect(
      captureTradeProposal("prepare_swap", toolSuccess("prepare_swap", { proposal }), undefined),
    ).toEqual(proposal);
    expect(
      captureTradeProposal("trade_prepare_swap", toolSuccess("trade_prepare_swap", { proposal }), undefined),
    ).toEqual(proposal);
    expect(
      captureTradeProposal(
        "tokenized_stock_prepare_order",
        toolSuccess("tokenized_stock_prepare_order", { proposal }),
        undefined,
      ),
    ).toEqual(proposal);
  });

  it("never captures a proposal from a failed or execute-mode tool", () => {
    expect(
      captureTradeProposal(
        "prepare_swap",
        toolError("prepare_swap", { code: "PROVIDER_ERROR", message: "no route" }),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      captureTradeProposal("trade_execute", toolSuccess("trade_execute", { proposal }), undefined),
    ).toBeUndefined();
  });
});

describe("runToolCallingLoop — prepare_swap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the proposal and a grounded reply when the model calls prepare_swap", async () => {
    const { agentToolRuntime } = await import("@/lib/architecture/tools/agent-tool-runtime-instance");
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolSuccess("prepare_swap", { proposal }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "prepare_swap", arguments: { sellSymbol: "USDC", buySymbol: "cbADA", amount: "10" } } }),
      )
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "Proposal ready." }));

    const response = await runToolCallingLoop(
      makeRequest("Swap 10 USDC to cbADA"),
      "base prompt",
      sendCompletion,
    );

    expect(response.tradeProposal).toEqual(proposal);
    expect(sendCompletion).toHaveBeenCalledTimes(1); // stop once the review-only proposal exists
  });
});
