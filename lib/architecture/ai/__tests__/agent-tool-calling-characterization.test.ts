import { describe, expect, it } from "vitest";
import {
  parseModelDirective,
  normalizeX402ToolArguments,
  normalizeTradeToolArguments,
  synthesizeFinalReplyFromToolResult,
  selectAdvertisedToolsForPrompt,
  getReadOnlyToolCatalog,
  getReadAndPrepareToolCatalog,
} from "@/lib/architecture/ai/agent-tool-calling";

describe("agent-tool-calling Characterization Tests (Task 13)", () => {
  describe("parseModelDirective", () => {
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
  });

  describe("normalizeX402ToolArguments", () => {
    it("normalizes resource/url into resourceUrl", () => {
      const args = {
        resource: "https://api.example.com/data",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
      };
      const normalized = normalizeX402ToolArguments("x402_prepare_payment", args);
      expect(normalized.resourceUrl).toBe("https://api.example.com/data");
      expect(normalized.resource).toBeUndefined();
    });
  });

  describe("normalizeTradeToolArguments", () => {
    it("handles negative trade amounts gracefully without crashing", () => {
      const args = {
        amountIn: "-50",
      };
      const normalized = normalizeTradeToolArguments("trade_get_price", args, "swap -50 usdc");
      expect(normalized).toBeDefined();
    });
  });

  describe("selectAdvertisedToolsForPrompt and tool catalogs", () => {
    it("returns tools appropriate for yield prompts", () => {
      const tools = selectAdvertisedToolsForPrompt("what are the best staking yield opportunities?");
      const toolIds = tools.map((t) => t.id);
      expect(toolIds).toContain("yield_opportunities");
    });

    it("returns read-only and prepare tools", () => {
      const readOnly = getReadOnlyToolCatalog();
      const readAndPrepare = getReadAndPrepareToolCatalog();
      expect(readOnly.length).toBeGreaterThan(0);
      expect(readAndPrepare.length).toBeGreaterThanOrEqual(readOnly.length);
    });
  });

  describe("synthesizeFinalReplyFromToolResult", () => {
    it("formats successful tool result cleanly", () => {
      const reply = synthesizeFinalReplyFromToolResult("portfolio_analyzer", {
        toolId: "portfolio_analyzer",
        success: true,
        metadata: { durationMs: 5, timestamp: new Date().toISOString() },
        data: {
          summary: "Portfolio healthy",
        },
      });
      expect(reply).toBeDefined();
      expect(typeof reply).toBe("string");
    });
  });
});
