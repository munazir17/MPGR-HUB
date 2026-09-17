import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractTradeSymbol,
  isCryptoSwapQuotePrompt,
  isTradePrompt,
  isTradeQuotePrompt,
} from "@/lib/agent-intelligence";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { AIProviderRequest } from "../ai-provider";
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import {
  tokenizedStockPrepareOrderTool,
  tokenizedStockResearchTool,
  tradePrepareSwapTool,
} from "@/lib/architecture/tools/trade-tool-definitions";

vi.mock("../agent-tool-calling", () => ({
  runRegisteredTool: vi.fn(),
}));

import { runRegisteredTool } from "../agent-tool-calling";

const runTool = vi.mocked(runRegisteredTool);

const PREPARE_PROMPT = "Prepare a trade to buy $50 worth of a tokenized AAPL stock";

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
  id: "b20_aapl_prepare",
  requiresConfirmation: true,
  network: "base",
  kind: "tokenized-stock-swap",
  provider: "aerodrome-slipstream",
  fromAmount: "50000000",
};

describe("tokenized-stock research and prepare routing", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("classifies AAPL as catalog AAPLc and not a generic crypto swap", () => {
    expect(isTradePrompt(PREPARE_PROMPT)).toBe(true);
    expect(isTradeQuotePrompt(PREPARE_PROMPT)).toBe(true);
    expect(extractTradeSymbol(PREPARE_PROMPT)).toBe("AAPLc");
    expect(isCryptoSwapQuotePrompt(PREPARE_PROMPT)).toBe(false);
  });

  it("research of the catalog uses tokenized_stock_research", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_research", {
        report: { kind: "catalog", assets: [{ symbol: "AAPLc" }] },
      }),
    );
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Research tokenized stocks on Base"),
    );
    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_research",
      {},
      expect.any(Object),
    );
    expect(runTool).not.toHaveBeenCalledWith("trade_prepare_swap", expect.anything(), expect.anything());
    expect(response.tokenizedStockReport).toEqual({ kind: "catalog", assets: [{ symbol: "AAPLc" }] });
    expect(response.reply.toLowerCase()).toContain("research only");
    expect(response.reply.toLowerCase()).toMatch(/will not sign|nothing was signed/);
  });

  it("AAPL prepare uses the dedicated path and never generic swap routing", async () => {
    runTool.mockResolvedValue(toolSuccess("tokenized_stock_prepare_order", { proposal }));
    const response = await new DeterministicAIProvider().generateReply(makeRequest(PREPARE_PROMPT));
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "AAPLc", amount: "50", side: "BUY" },
      expect.any(Object),
    );
    expect(runTool).not.toHaveBeenCalledWith("trade_prepare_swap", expect.anything(), expect.anything());
    expect(runTool.mock.calls[0]?.[0]).not.toMatch(/execute|submit|broadcast|sign/i);
    expect(response.tradeProposal).toEqual(proposal);
    expect(response.tradeProposal?.requiresConfirmation).toBe(true);
    expect(response.reply.toLowerCase()).toContain("nothing is signed or submitted");
    expect(response.reply.toLowerCase()).toContain("explicitly confirm");
  });

  it("prepare-only never claims execution and dedicated tools never execute", () => {
    expect(tokenizedStockPrepareOrderTool.mode).toBe("prepare");
    expect(tokenizedStockPrepareOrderTool.requiresConfirmation).toBe(true);
    expect(tokenizedStockResearchTool.mode).toBe("read");
    expect(tradePrepareSwapTool.mode).toBe("prepare");
    expect(tradePrepareSwapTool.requiresConfirmation).toBe(true);
    for (const tool of [tokenizedStockPrepareOrderTool, tokenizedStockResearchTool, tradePrepareSwapTool]) {
      expect(tool.mode).not.toBe("execute");
    }
  });

  it("returns a clear catalog miss instead of guessing", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Prepare a trade to buy $50 worth of a tokenized ZZZc stock"),
    );
    expect(runTool).not.toHaveBeenCalled();
    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply.toLowerCase()).toContain("cannot safely resolve");
    expect(response.reply.toLowerCase()).toContain("nothing was signed");
  });

  it("surfaces a grounded prepare failure instead of inventing a quote", async () => {
    runTool.mockResolvedValue(
      toolError("tokenized_stock_prepare_order", {
        code: "DATA_UNAVAILABLE",
        message: "Aerodrome Slipstream reported no USDC pool liquidity for AAPLc on Base.",
      }),
    );
    const response = await new DeterministicAIProvider().generateReply(makeRequest(PREPARE_PROMPT));
    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply).toContain("no USDC pool liquidity");
    expect(response.reply.toLowerCase()).toContain("nothing was signed");
  });
});
