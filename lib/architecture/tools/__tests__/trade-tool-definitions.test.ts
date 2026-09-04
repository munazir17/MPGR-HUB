import { describe, expect, it, vi } from "vitest";

import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";

const { tradeGetPriceTool, tradePrepareSwapTool, tokenizedStockResearchTool } = await import(
  "../trade-tool-definitions"
);

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

function makeRuntime() {
  const registry = new AgentToolRegistry();
  for (const tool of [tradeGetPriceTool, tradePrepareSwapTool, tokenizedStockResearchTool]) {
    registry.register(tool);
  }
  const { eventBus, logger, performanceMonitor } = makeDeps();
  return new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);
}

describe("P4 trade tools", () => {
  it("registers read/prepare tools only — never execute", () => {
    expect(tradeGetPriceTool.mode).toBe("read");
    expect(tradePrepareSwapTool.mode).toBe("prepare");
    expect(tokenizedStockResearchTool.mode).toBe("read");
    expect(tradePrepareSwapTool.requiresConfirmation).toBe(true);
  });

  it("trade_prepare_swap captures a structured proposal from /api/trade/quote", async () => {
    const proposal = {
      id: "trade_x",
      requiresConfirmation: true,
      network: "base",
      provider: "cdp-trade-api",
      fromAmount: "1000000",
      executionAvailable: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ proposal }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "trade_prepare_swap",
      {
        fromToken: "USDC",
        toToken: "WETH",
        fromAmount: "1000000",
        taker: "0x2222222222222222222222222222222222222222",
      },
      { confirmationMode: "always_confirm", requestId: "t1", walletAddress: "0x2222222222222222222222222222222222222222" },
    );
    expect(result.success).toBe(true);
    expect((result.data as { proposal: { id: string } }).proposal.id).toBe("trade_x");
    vi.unstubAllGlobals();
  });

  it("tokenized_stock_research lists the official catalog when symbol is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "catalog",
            assets: [{ symbol: "AAPLc" }, { symbol: "TSLAc" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "tokenized_stock_research",
      {},
      { confirmationMode: "always_confirm", requestId: "t2" },
    );
    expect(result.success).toBe(true);
    const report = (result.data as { report: { kind: string; assets: unknown[] } }).report;
    expect(report.kind).toBe("catalog");
    expect(report.assets).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
