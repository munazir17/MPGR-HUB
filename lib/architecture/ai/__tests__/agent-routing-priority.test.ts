import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectIntent,
  extractCryptoSwapPair,
  extractTransferRequest,
  isCryptoSwapQuotePrompt,
  isTradePrompt,
  isTransferPrompt,
  isX402PaymentPrompt,
} from "@/lib/agent-intelligence";
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
    agentContext: {
      isConnected: true,
      portfolio: {
        walletBalance: 10,
        stakedBalance: 5,
        lockedBalance: 2,
        totalHoldings: 17,
        claimableRewards: 1,
        nativeEth: "0.01",
        usdc: "3",
      },
      xp: {
        xp: 100,
        level: 2,
        nextLevel: 3,
        xpIntoLevel: 10,
        xpNeededForLevel: 50,
        progress: 20,
        streak: 1,
        referralCount: 0,
      },
      holderTier: {
        tierLabel: "Bronze",
        totalScore: 17,
        nextTierLabel: null,
        progressToNextTier: 0,
        amountToNextTier: 0,
        votingWeight: 17,
        reputationScore: 1,
      },
      premium: null,
      staking: { totalStaked: 5, earnedRewards: 0, currentAPRPercent: null },
      tokenLock: { totalLocked: 2, activeLocksCount: 1, upcomingUnlockAt: null },
      season: { seasonNumber: 1, seasonPoints: 9, level: 1, progress: 0 },
      rewards: { claimableTotal: 1, totalClaimed: 0 },
    } as AIProviderRequest["agentContext"],
    previousIntent: "portfolio_summary",
    memoryContext: {
      isReturningUser: true,
      interactionCount: 4,
      favoriteTopics: ["portfolio_summary"],
      conversationSummaries: [],
      dominantRecentIntent: "portfolio_summary",
    } as unknown as AIProviderRequest["memoryContext"],
    address: "0x00000000000000000000000000000000000000aa",
  };
}

describe("crypto swap quote routing", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  const quotes = [
    "Give me a live Base swap quote for ETH to USDC",
    "Quote ETH -> USDC on Base",
    "How much USDC do I get for 0.1 ETH?",
    "What's the swap price for ETH to USDC?",
    "Give me the current ETH price in USDC",
    "Quote MPGR to USDC",
    "Quote USDC to ETH",
  ];

  it.each(quotes)("classifies %s as a crypto swap quote, not B20", (prompt) => {
    expect(isCryptoSwapQuotePrompt(prompt)).toBe(true);
    expect(extractCryptoSwapPair(prompt)).toBeTruthy();
    const pair = extractCryptoSwapPair(prompt);
    expect(pair?.fromToken && pair?.toToken).toBeTruthy();
    expect(["ETH", "WETH", "USDC", "MPGR"]).toContain(pair!.fromToken);
    expect(["ETH", "WETH", "USDC", "MPGR"]).toContain(pair!.toToken);
  });

  it("does not treat research as a swap", () => {
    expect(isCryptoSwapQuotePrompt("What is MPGR HUB and what does $MPGR do?")).toBe(false);
    expect(isCryptoSwapQuotePrompt("Research the current Base ecosystem and explain how MPGR HUB fits into it.")).toBe(
      false,
    );
  });

  it("calls trade_get_price instead of tokenized_stock_research", async () => {
    runTool.mockResolvedValue(
      toolSuccess("trade_get_price", { price: { amount: "1" }, provider: "cdp" }),
    );
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Give me a live Base swap quote for ETH to USDC"),
    );
    expect(runTool).toHaveBeenCalledWith(
      "trade_get_price",
      expect.objectContaining({ fromToken: "ETH", toToken: "USDC" }),
      expect.any(Object),
    );
    expect(runTool).not.toHaveBeenCalledWith("tokenized_stock_research", expect.anything(), expect.anything());
    expect(response.reply.toLowerCase()).not.toContain("tokenized stock");
    expect(response.reply.toLowerCase()).toContain("quote");
  });

  it("does not invent a price when the quote tool fails", async () => {
    runTool.mockResolvedValue(
      toolError("trade_get_price", { code: "DATA_UNAVAILABLE", message: "No live quote.", retryable: true }),
    );
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Quote ETH to USDC"),
    );
    expect(response.reply.toLowerCase()).toContain("will not invent");
  });
});

describe("transfer prepare routing", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("rejects a placeholder address", () => {
    const prompt = "Prepare a transfer of 0.000001 ETH to 0xYOUR_TEST_ADDRESS. Do not execute it.";
    expect(extractTransferRequest(prompt)).toBeNull();
  });

  it("parses a valid 0x recipient", () => {
    const prompt = "Prepare a transfer of 0.000001 ETH to 0x00000000000000000000000000000000000000aa. Do not execute it.";
    expect(extractTransferRequest(prompt)).toEqual({
      token: "ETH",
      amount: "0.000001",
      recipient: "0x00000000000000000000000000000000000000aa",
    });
  });

  it("parses a Basename recipient", () => {
    const prompt = "Prepare sending 0.000001 ETH to jesse.base.eth. Do not execute.";
    expect(isTransferPrompt(prompt)).toBe(true);
    expect(extractTransferRequest(prompt)).toEqual({
      token: "ETH",
      amount: "0.000001",
      recipient: "jesse.base.eth",
    });
  });

  it("prepares only and never claims execution", async () => {
    runTool.mockResolvedValue(
      toolSuccess("transfer_prepare_send", {
        proposal: { requiresConfirmation: true, to: "0x00000000000000000000000000000000000000aa" },
      }),
    );
    const response = await new DeterministicAIProvider().generateReply(
      makeRequest("Prepare a transfer of 0.000001 ETH to 0x00000000000000000000000000000000000000aa. Do not execute it."),
    );
    expect(runTool).toHaveBeenCalledWith(
      "transfer_prepare_send",
      expect.objectContaining({ token: "ETH", amount: "0.000001" }),
      expect.any(Object),
    );
    expect(response.reply.toLowerCase()).toContain("nothing is signed");
  });
});

describe("account vs research vs x402", () => {
  it("keeps portfolio and account intents", () => {
    expect(detectIntent("Analyze my portfolio", null).intent).toBe("portfolio_summary");
    expect(detectIntent("Analyze my portfolio and explain my MPGR exposure", null).intent).toBe("portfolio_summary");
    expect(detectIntent("Show my portfolio summary", null).intent).toBe("portfolio_summary");
    expect(detectIntent("How much XP do I have?", null).intent).toBe("xp_status");
    expect(detectIntent("What's my Holder Tier?", null).intent).toBe("holder_tier");
    expect(detectIntent("How many season points do I have?", null).intent).toBe("season_progress");
    expect(detectIntent("What rewards can I claim?", null).intent).toBe("claimable_rewards");
  });

  it("keeps informational research off the action paths", () => {
    expect(detectIntent("What is MPGR HUB and what does $MPGR do?", "portfolio_summary").intent).toBe("research_query");
    expect(detectIntent("Research $MPGR and explain its utility on Base.", null).intent).toBe("research_query");
    expect(
      detectIntent("Research the current Base ecosystem and explain how MPGR HUB fits into it.", null).intent,
    ).toBe("research_query");
    expect(isTradePrompt("What is MPGR HUB and what does $MPGR do?")).toBe(false);
    expect(isTransferPrompt("What is MPGR HUB and what does $MPGR do?")).toBe(false);
  });

  it("treats explain-x402 as information and a URL as payment intent", () => {
    expect(isX402PaymentPrompt("Explain x402 and how it can be used by AI agents.")).toBe(false);
    expect(detectIntent("Explain x402 and how it can be used by AI agents.", null).intent).toBe("research_query");
    expect(
      isX402PaymentPrompt(
        "Prepare a payment proposal for this x402 resource: https://x402-demo-discovery-endpoint.vercel.app/protected",
      ),
    ).toBe(true);
  });
});

describe("transfer/swap win over x402 when both keywords appear", () => {
  afterEach(() => {
    runTool.mockReset();
  });

  it("routes an explicit transfer or swap before x402", async () => {
    const transferPrompt =
      "Prepare a transfer of 0.000001 ETH to 0x00000000000000000000000000000000000000aa. Also inspect this x402 resource https://x402-demo-discovery-endpoint.vercel.app/protected";
    expect(isTransferPrompt(transferPrompt)).toBe(true);
    expect(isX402PaymentPrompt(transferPrompt)).toBe(true);

    runTool.mockResolvedValue(
      toolSuccess("transfer_prepare_send", { proposal: { requiresConfirmation: true } }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest(transferPrompt));
    expect(runTool.mock.calls[0]?.[0]).toBe("transfer_prepare_send");
    expect(runTool).not.toHaveBeenCalledWith("x402_prepare_payment", expect.anything(), expect.anything());

    runTool.mockReset();
    const swapPrompt =
      "Give me a live Base swap quote for ETH to USDC and also this x402 resource https://x402-demo-discovery-endpoint.vercel.app/protected";
    expect(isCryptoSwapQuotePrompt(swapPrompt)).toBe(true);
    expect(isX402PaymentPrompt(swapPrompt)).toBe(true);

    runTool.mockResolvedValue(
      toolSuccess("trade_get_price", { price: { amount: "1" }, provider: "cdp" }),
    );
    await new DeterministicAIProvider().generateReply(makeRequest(swapPrompt));
    expect(runTool.mock.calls[0]?.[0]).toBe("trade_get_price");
    expect(runTool).not.toHaveBeenCalledWith("x402_prepare_payment", expect.anything(), expect.anything());
  });
});
