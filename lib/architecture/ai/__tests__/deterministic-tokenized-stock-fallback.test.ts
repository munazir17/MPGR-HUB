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
      { symbol: "AAPLc", amount: "50", side: "BUY", amountUnit: "usd" },
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

  it("treats 'Sell my USDC worth of MSTRc' as an ORDER, never as research", async () => {
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Sell my USDC worth of MSTRc"),
    );

    // No research tool, no research card — the size is simply unknown.
    expect(runTool).not.toHaveBeenCalled();
    expect(response.tokenizedStockReport).toBeUndefined();
    expect(response.tradeProposal).toBeUndefined();
    const reply = response.reply.toLowerCase();
    expect(reply).toContain("how much");
    expect(reply).toContain("mstrc");
    expect(reply).toContain("usdc");
    expect(reply).toContain("nothing is signed");
    expect(reply).not.toContain("research only");
  });

  it("reads 'sell X USDC worth of MSTRc' as a SELL of MSTRc worth X USDC", async () => {
    runTool.mockResolvedValue(toolSuccess("tokenized_stock_prepare_order", { proposal }));
    await new DeterministicAIProvider().generateReply(
      makeRequest("Sell 100 USDC worth of MSTRc"),
    );
    // The SELL verb governs and the dollar figure is the sale's value
    // target — this must never be prepared as a USDC-funded BUY of MSTRc.
    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "MSTRc", amount: "100", side: "SELL", amountUnit: "usd" },
      expect.any(Object),
    );
  });

  it("keeps an unreferenced B20 sell as a SELL", async () => {
    runTool.mockResolvedValue(toolSuccess("tokenized_stock_prepare_order", { proposal }));
    await new DeterministicAIProvider().generateReply(makeRequest("Sell 5 MSTRc"));
    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "MSTRc", amount: "5", side: "SELL", amountUnit: "token" },
      expect.any(Object),
    );
  });

  it("prepares a B20 sell order that does carry a size", async () => {
    runTool.mockResolvedValue(toolSuccess("tokenized_stock_prepare_order", { proposal }));
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Sell 5 MSTRc"),
    );
    expect(runTool).toHaveBeenCalledWith(
      "tokenized_stock_prepare_order",
      { symbol: "MSTRc", amount: "5", side: "SELL", amountUnit: "token" },
      expect.any(Object),
    );
    expect(response.tradeProposal).toEqual(proposal);
    expect(response.reply.toLowerCase()).toContain("nothing is signed or submitted");
  });

  it("still answers research wordings with research (no order detected)", async () => {
    runTool.mockResolvedValue(
      toolSuccess("tokenized_stock_research", { report: { kind: "catalog", assets: [] } }),
    );
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Check MSTRc price and oracle"),
    );
    expect(runTool).toHaveBeenCalledWith("tokenized_stock_research", { symbol: "MSTRc" }, expect.any(Object));
    expect(response.reply.toLowerCase()).toContain("research only");
    expect(response.tradeProposal).toBeUndefined();
  });

  it("never turns an advice question into an order", async () => {
    // "buy " is a trade-quote marker, so this lands on the prepare family —
    // but with no size it must stop at the amount question, never produce
    // a proposal, and never claim anything is ready to sign.
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Should I buy AAPLc?"),
    );
    expect(response.tradeProposal).toBeUndefined();
    expect(
      runTool.mock.calls.some((call) => call[0] === "tokenized_stock_prepare_order"),
    ).toBe(false);
    expect(response.reply.toLowerCase()).not.toContain("research only");
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
