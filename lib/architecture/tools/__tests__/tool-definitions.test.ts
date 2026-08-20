import { describe, expect, it } from "vitest";
import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";
import {
  baseResearchTool,
  marketIntelligenceTool,
  portfolioAnalyzerTool,
  tokenAnalyzerTool,
  walletAnalyzerTool,
} from "../tool-definitions";

function makeDeps() {
  const eventBus: EventBus = { on: () => () => {}, off: () => {}, emit: () => {}, use: () => () => {} };
  const logger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };
  const performanceMonitor: PerformanceMonitor = {
    time: async (_l, fn) => fn(),
    timeSync: (_l, fn) => fn(),
    getMetrics: () => [],
    clear: () => {},
  };
  return { eventBus, logger, performanceMonitor };
}

const ALL_TOOLS = [walletAnalyzerTool, tokenAnalyzerTool, portfolioAnalyzerTool, baseResearchTool, marketIntelligenceTool];

describe("P0.1 placeholder tool definitions", () => {
  it("all five declare read mode, low risk, and no confirmation requirement", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.mode).toBe("read");
      expect(tool.riskLevel).toBe("low");
      expect(tool.requiresConfirmation).toBe(false);
    }
  });

  it("wallet_analyzer and portfolio_analyzer require a wallet; the others do not", () => {
    expect(walletAnalyzerTool.requiresWallet).toBe(true);
    expect(portfolioAnalyzerTool.requiresWallet).toBe(true);
    expect(tokenAnalyzerTool.requiresWallet).toBe(false);
    expect(baseResearchTool.requiresWallet).toBe(false);
    expect(marketIntelligenceTool.requiresWallet).toBe(false);
  });

  it("every tool returns TOOL_NOT_IMPLEMENTED and no fabricated data when run through the runtime", async () => {
    const registry = new AgentToolRegistry();
    for (const tool of ALL_TOOLS) registry.register(tool);
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const walletResult = await runtime.executeTool(
      "wallet_analyzer",
      { walletAddress: "0x0000000000000000000000000000000000dead" },
      { confirmationMode: "always_confirm", requestId: "r1", walletAddress: "0x0000000000000000000000000000000000dead" }
    );
    expect(walletResult.success).toBe(false);
    expect(walletResult.error?.code).toBe("TOOL_NOT_IMPLEMENTED");
    expect(walletResult.data).toBeUndefined();

    const tokenResult = await runtime.executeTool(
      "token_analyzer",
      { tokenSymbolOrAddress: "MPGR" },
      { confirmationMode: "always_confirm", requestId: "r2" }
    );
    expect(tokenResult.success).toBe(false);
    expect(tokenResult.error?.code).toBe("TOOL_NOT_IMPLEMENTED");
  });

  it("register each definition into a fresh registry without a duplicate-id collision", () => {
    const registry = new AgentToolRegistry();
    expect(() => ALL_TOOLS.forEach((t) => registry.register(t))).not.toThrow();
    expect(registry.list().length).toBe(5);
  });
});

