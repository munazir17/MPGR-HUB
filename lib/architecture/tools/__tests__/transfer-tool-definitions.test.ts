import { describe, expect, it, vi } from "vitest";

import { AgentToolRegistry } from "../agent-tool-registry";
import { AgentToolRuntime } from "../agent-tool-runtime";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";

const { transferPrepareSendTool } = await import("../transfer-tool-definitions");

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
  registry.register(transferPrepareSendTool);
  const { eventBus, logger, performanceMonitor } = makeDeps();
  return new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);
}

describe("transfer_prepare_send agent tool", () => {
  it("is registered as prepare-only, high risk, requires wallet + confirmation — never execute", () => {
    expect(transferPrepareSendTool.mode).toBe("prepare");
    expect(transferPrepareSendTool.requiresConfirmation).toBe(true);
    expect(transferPrepareSendTool.requiresWallet).toBe(true);
    expect(transferPrepareSendTool.riskLevel).toBe("high");
  });

  it("declares token, amount, and recipient as required schema fields — nothing optional that would let the model skip them", () => {
    expect(transferPrepareSendTool.inputSchema.required).toEqual(
      expect.arrayContaining(["token", "amount", "recipient"]),
    );
  });

  it("refuses to call the API at all when no recipient is supplied, rather than letting the server guess", async () => {
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "transfer_prepare_send",
      { token: "ETH", amount: "0.01" },
      { confirmationMode: "always_confirm", requestId: "t1", walletAddress: "0x2222222222222222222222222222222222222222" },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("captures a structured proposal from /api/transfer/quote on success", async () => {
    const proposal = {
      id: "transfer_x",
      requiresConfirmation: true,
      network: "base",
      kind: "native-transfer",
      amount: "10000000000000000",
      sender: "0x2222222222222222222222222222222222222222",
      recipient: { address: "0x3333333333333333333333333333333333333333", inputKind: "address", basename: null },
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
      "transfer_prepare_send",
      { token: "ETH", amount: "0.01", recipient: "0x3333333333333333333333333333333333333333" },
      { confirmationMode: "always_confirm", requestId: "t2", walletAddress: "0x2222222222222222222222222222222222222222" },
    );
    expect(result.success).toBe(true);
    expect((result.data as { proposal: { id: string } }).proposal.id).toBe("transfer_x");
    vi.unstubAllGlobals();
  });

  it("surfaces a server-side rejection (e.g. unresolved Basename) as a tool error instead of fabricating a proposal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Could not resolve recipient.", code: "RECIPIENT_UNRESOLVED" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const runtime = makeRuntime();
    const result = await runtime.executeTool(
      "transfer_prepare_send",
      { token: "ETH", amount: "0.01", recipient: "doesnotexist.base.eth" },
      { confirmationMode: "always_confirm", requestId: "t3", walletAddress: "0x2222222222222222222222222222222222222222" },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    vi.unstubAllGlobals();
  });
});
