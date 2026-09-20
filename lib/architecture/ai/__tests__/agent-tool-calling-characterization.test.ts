import { describe, expect, it, vi } from "vitest";
import {
  parseModelDirective,
  normalizeX402ToolArguments,
  normalizeTradeToolArguments,
  hasNegativeTradeAmount,
  synthesizeFinalReplyFromToolResult,
  selectAdvertisedToolsForPrompt,
  getReadOnlyToolCatalog,
  getReadAndPrepareToolCatalog,
  buildGatedCapabilityInstructions,
  buildToolCatalogPromptBlock,
  buildCompactToolCatalogPromptBlock,
  runRegisteredReadTool,
  runRegisteredTool,
  runToolCallingLoop,
} from "@/lib/architecture/ai/agent-tool-calling";
import type { AIProviderRequest } from "@/lib/architecture/ai/ai-provider";
import type { ConversationMemoryContext } from "@/lib/architecture/memory/memory-context";

const emptyMemory: ConversationMemoryContext = {
  relevantHistory: [],
  conversationSummaries: [],
  sessionTurnCount: 0,
  sessionRecentTopics: [],
  interactionCount: 0,
  lastAction: null,
  isReturningUser: false,
  dominantRecentIntent: null,
  favoriteTopics: [],
  walletDelta: null,
  mostUsedCommands: [],
  recentPages: [],
  preferredToken: "MPGR",
};

describe("agent-tool-calling Characterization & Modularized Behaviors (Task 13)", () => {
  describe("tool-call-parser: parseModelDirective", () => {
    it("parses valid json tool call directive with toolCall object", () => {
      const content = JSON.stringify({
        toolCall: {
          toolId: "wallet_analyzer",
          arguments: { wallet: "0x1111111111111111111111111111111111111111" },
        },
      });
      const directive = parseModelDirective(content, "portfolio_summary");
      expect(directive.kind).toBe("tool_call");
      if (directive.kind === "tool_call") {
        expect(directive.toolId).toBe("wallet_analyzer");
        expect(directive.arguments).toEqual({ wallet: "0x1111111111111111111111111111111111111111" });
      }
    });

    it("parses final answer when plain text reply", () => {
      const content = "Hello, your balance is 100 MPGR.";
      const directive = parseModelDirective(content, "portfolio_summary");
      expect(directive.kind).toBe("final");
      if (directive.kind === "final") {
        expect(directive.reply).toBe(content);
        expect(directive.intent).toBe("portfolio_summary");
      }
    });

    it("extracts json tool call embedded in markdown code blocks", () => {
      const content = "```json\n{\n  \"toolCall\": {\n    \"toolId\": \"trade_get_price\",\n    \"arguments\": {\"tokenIn\": \"USDC\", \"tokenOut\": \"MPGR\"}\n  }\n}\n```";
      const directive = parseModelDirective(content, "market_overview");
      expect(directive.kind).toBe("tool_call");
      if (directive.kind === "tool_call") {
        expect(directive.toolId).toBe("trade_get_price");
      }
    });

    it("parses JSON object containing reply and explicit intent", () => {
      const content = JSON.stringify({
        intent: "staking_summary",
        reply: "You have 500 MPGR staked earning 12% APR.",
      });
      const directive = parseModelDirective(content, "general_help");
      expect(directive.kind).toBe("final");
      if (directive.kind === "final") {
        expect(directive.intent).toBe("staking_summary");
        expect(directive.reply).toBe("You have 500 MPGR staked earning 12% APR.");
      }
    });

    it("throws error when response is whitespace only", () => {
      expect(() => parseModelDirective("   ", null)).toThrow("AI provider response was missing a non-empty reply.");
    });
  });

  describe("tool-call-normalization: x402, trade taker, and negative amount security", () => {
    it("normalizes resource/url into resourceUrl for x402 tools", () => {
      const args1 = {
        resource: "https://api.example.com/data",
        amount: "1000000",
      };
      const normalized1 = normalizeX402ToolArguments("x402_prepare_payment", args1);
      expect(normalized1.resourceUrl).toBe("https://api.example.com/data");
      expect(normalized1.resource).toBeUndefined();

      const args2 = {
        url: "https://api.example.com/resource2",
      };
      const normalized2 = normalizeX402ToolArguments("x402_discover_resource", args2);
      expect(normalized2.resourceUrl).toBe("https://api.example.com/resource2");
      expect(normalized2.url).toBeUndefined();
    });

    it("does not mutate args if tool is not x402", () => {
      const args = { url: "https://example.com" };
      const normalized = normalizeX402ToolArguments("portfolio_analyzer", args);
      expect(normalized).toBe(args);
    });

    it("hydrates taker address from connected wallet for trade tools", () => {
      const wallet = "0x9999999999999999999999999999999999999999";
      const normalized = normalizeTradeToolArguments(
        "tokenized_stock_research",
        { symbol: "AAPLc" },
        wallet,
      );
      expect(normalized.taker).toBe(wallet);
    });

    it("detects negative trade or transfer amounts correctly for security rejection", () => {
      expect(hasNegativeTradeAmount("swap -50 USDC to ETH")).toBe(true);
      expect(hasNegativeTradeAmount("buy -$100 of AAPLc")).toBe(true);
      expect(hasNegativeTradeAmount("send -5 ETH to 0x123")).toBe(true);
      expect(hasNegativeTradeAmount("swap 50 USDC to ETH")).toBe(false);
      expect(hasNegativeTradeAmount("tell me about negative interest rates")).toBe(false);
    });
  });

  describe("tool-catalog-selector: tool selection, instructions, and catalog blocks", () => {
    it("selects yield tools for yield-related queries", () => {
      const tools = selectAdvertisedToolsForPrompt("what are the best staking yield opportunities?");
      const toolIds = tools.map((t) => t.id);
      expect(toolIds).toContain("yield_opportunities");
    });

    it("selects x402 tools when prompt mentions x402 payment", () => {
      const tools = selectAdvertisedToolsForPrompt("prepare payment for x402 resource https://api.payai.network");
      const toolIds = tools.map((t) => t.id);
      expect(toolIds).toContain("x402_prepare_payment");
    });

    it("selects trade tools when prompt asks to swap or buy", () => {
      const tools = selectAdvertisedToolsForPrompt("prepare a swap from USDC to MPGR");
      const toolIds = tools.map((t) => t.id);
      expect(toolIds).toContain("trade_prepare_swap");
    });

    it("builds gated capability instructions appropriately", () => {
      const instructions = buildGatedCapabilityInstructions("prepare a swap from USDC to MPGR");
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.some((line) => line.includes("Base Mainnet only"))).toBe(true);
    });

    it("formats tool catalog prompt block with tool ids and schemas", () => {
      const tools = getReadOnlyToolCatalog();
      const block = buildToolCatalogPromptBlock(tools.slice(0, 2));
      expect(block).toContain("Available tools:");
      expect(block).toContain(tools[0].id);

      const compactBlock = buildCompactToolCatalogPromptBlock(tools.slice(0, 2));
      expect(compactBlock).toContain("Available tool IDs:");
    });
  });

  describe("tool-execution-service: execution policies and proposal synthesis", () => {
    const mockRequest: AIProviderRequest = {
      prompt: "test",
      address: "0x1234567890123456789012345678901234567890",
      previousIntent: null,
      agentContext: {
        isConnected: true,
        xp: null,
        portfolio: null,
        premium: null,
        holderTier: null,
        staking: null,
        tokenLock: null,
        season: null,
        rewards: null,
      },
      memoryContext: emptyMemory,
    };

    it("rejects execute mode tools in runRegisteredReadTool", async () => {
      const result = await runRegisteredReadTool(
        "trade_prepare_swap", // prepare, not read
        {},
        mockRequest,
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    });

    it("synthesizes grounded reply for completed tool lookups", () => {
      const reply = synthesizeFinalReplyFromToolResult("yield_opportunities", {
        toolId: "yield_opportunities",
        success: true,
        metadata: { durationMs: 10, timestamp: new Date().toISOString() },
        data: { opportunities: [] },
      });
      expect(reply).toContain("I finished that lookup.");
      expect(reply).toContain("I will not sign or submit any transaction.");
    });
  });

  describe("runToolCallingLoop orchestration", () => {
    it("handles one-turn completion cleanly without tools", async () => {
      const mockRequest: AIProviderRequest = {
        prompt: "How does MPGR work?",
        address: "0x1234567890123456789012345678901234567890",
        previousIntent: null,
        agentContext: {
          isConnected: true,
          xp: null,
          portfolio: null,
          premium: null,
          holderTier: null,
          staking: null,
          tokenLock: null,
          season: null,
          rewards: null,
        },
        memoryContext: emptyMemory,
      };

      const sendCompletion = vi.fn().mockResolvedValue(
        JSON.stringify({
          intent: "research_query",
          reply: "MPGR is the utility token on Base.",
        })
      );

      const response = await runToolCallingLoop(
        mockRequest,
        "System prompt",
        sendCompletion,
      );

      expect(response.intent).toBe("research_query");
      expect(response.reply).toBe("MPGR is the utility token on Base.");
      expect(sendCompletion).toHaveBeenCalledTimes(1);
    });

    it("blocks negative trade amount prompts before invoking model completion", async () => {
      const mockRequest: AIProviderRequest = {
        prompt: "buy -$20 worth of AAPLc",
        address: "0x1234567890123456789012345678901234567890",
        previousIntent: null,
        agentContext: {
          isConnected: true,
          xp: null,
          portfolio: null,
          premium: null,
          holderTier: null,
          staking: null,
          tokenLock: null,
          season: null,
          rewards: null,
        },
        memoryContext: emptyMemory,
      };

      const sendCompletion = vi.fn();
      const response = await runToolCallingLoop(
        mockRequest,
        "System prompt",
        sendCompletion,
      );

      expect(sendCompletion).not.toHaveBeenCalled();
      expect(response.reply).toContain("amount must be a positive value");
    });
  });
});
