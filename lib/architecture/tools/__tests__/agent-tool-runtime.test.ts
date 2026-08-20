import { describe, expect, it, vi } from "vitest";
import { AgentToolRuntime } from "../agent-tool-runtime";
import { AgentToolRegistry } from "../agent-tool-registry";
import { toolSuccess } from "../agent-tool-result";
import type { AgentTool } from "../agent-tool";
import type { EventBus, Logger, PerformanceMonitor } from "@/lib/architecture/core/types";

function makeDeps() {
  const emit = vi.fn();
  const eventBus: EventBus = {
    on: () => () => {},
    off: () => {},
    emit,
    use: () => () => {},
  };
  const logger: Logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const performanceMonitor: PerformanceMonitor = {
    time: async (_label, fn) => fn(),
    timeSync: (_label, fn) => fn(),
    getMetrics: () => [],
    clear: () => {},
  };
  return { emit, eventBus, logger, performanceMonitor };
}

function makeReadTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    id: "read_tool",
    name: "Read Tool",
    description: "A read tool for tests.",
    category: "research",
    mode: "read",
    riskLevel: "low",
    requiresWallet: false,
    requiresConfirmation: false,
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    execute: async () => toolSuccess("read_tool", { answer: 42 }),
    ...overrides,
  };
}

describe("AgentToolRuntime", () => {
  it("cannot execute an unregistered tool", async () => {
    const registry = new AgentToolRegistry();
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const result = await runtime.executeTool("nonexistent", {}, { confirmationMode: "always_confirm", requestId: "r1" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("registering the same id twice never lets the second definition run", async () => {
    const registry = new AgentToolRegistry();
    registry.register(makeReadTool());
    expect(() => registry.register(makeReadTool({ description: "a different tool" }))).toThrow();
    // the ORIGINAL definition is still what's registered
    expect(registry.get("read_tool")?.description).toBe("A read tool for tests.");
  });

  it("unconditionally refuses an execute-mode tool, regardless of permissions", async () => {
    const registry = new AgentToolRegistry();
    registry.register(
      makeReadTool({
        id: "dangerous_execute",
        mode: "execute",
        riskLevel: "critical",
        inputSchema: { type: "object", properties: {} },
      })
    );
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const result = await runtime.executeTool(
      "dangerous_execute",
      {},
      {
        confirmationMode: "always_confirm",
        requestId: "r1",
        permissions: { canRead: true, canPrepare: true, canExecute: true }, // even "true" must not matter
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_NOT_ALLOWED");
  });

  it("distinguishes read vs prepare vs execute", async () => {
    const registry = new AgentToolRegistry();
    registry.register(makeReadTool({ id: "r", mode: "read" }));
    registry.register(makeReadTool({ id: "p", mode: "prepare", inputSchema: { type: "object", properties: {} } }));
    registry.register(makeReadTool({ id: "e", mode: "execute", inputSchema: { type: "object", properties: {} } }));
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const readResult = await runtime.executeTool("r", { q: "x" }, { confirmationMode: "always_confirm", requestId: "1" });
    const prepareResult = await runtime.executeTool("p", {}, { confirmationMode: "always_confirm", requestId: "2" });
    const executeResult = await runtime.executeTool("e", {}, { confirmationMode: "always_confirm", requestId: "3" });

    expect(readResult.success).toBe(true);
    expect(prepareResult.success).toBe(true);
    expect(executeResult.success).toBe(false);
    expect(executeResult.error?.code).toBe("EXECUTION_NOT_ALLOWED");
  });

  it("requires a wallet when the tool declares requiresWallet", async () => {
    const registry = new AgentToolRegistry();
    registry.register(makeReadTool({ id: "wallet_needed", requiresWallet: true, inputSchema: { type: "object", properties: {} } }));
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const result = await runtime.executeTool("wallet_needed", {}, { confirmationMode: "always_confirm", requestId: "r1" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("WALLET_NOT_CONNECTED");
  });

  it("rejects invalid input against the tool's schema before calling execute", async () => {
    const registry = new AgentToolRegistry();
    const execute = vi.fn(async () => toolSuccess("read_tool", {}));
    registry.register(makeReadTool({ execute }));
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const result = await runtime.executeTool("read_tool", {}, { confirmationMode: "always_confirm", requestId: "r1" }); // missing required "q"

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves execution mode metadata and populates requestId/durationMs", async () => {
    const registry = new AgentToolRegistry();
    registry.register(makeReadTool());
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const result = await runtime.executeTool("read_tool", { q: "hi" }, { confirmationMode: "always_confirm", requestId: "req-123" });

    expect(result.success).toBe(true);
    expect(result.toolId).toBe("read_tool");
    expect(result.metadata.requestId).toBe("req-123");
    expect(typeof result.metadata.durationMs).toBe("number");
  });

  it("turns a thrown exception into a structured, non-leaking PROVIDER_ERROR", async () => {
    const registry = new AgentToolRegistry();
    registry.register(
      makeReadTool({
        execute: async () => {
          throw new Error("some internal secret stack detail");
        },
      })
    );
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const result = await runtime.executeTool("read_tool", { q: "hi" }, { confirmationMode: "always_confirm", requestId: "r1" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_ERROR");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).not.toContain("secret stack detail");
  });

  it("denies a read tool when permissions.canRead is false", async () => {
    const registry = new AgentToolRegistry();
    registry.register(makeReadTool());
    const { eventBus, logger, performanceMonitor } = makeDeps();
    const runtime = new AgentToolRuntime(registry, eventBus, logger, performanceMonitor);

    const result = await runtime.executeTool(
      "read_tool",
      { q: "hi" },
      {
        confirmationMode: "always_confirm",
        requestId: "r1",
        permissions: { canRead: false, canPrepare: true, canExecute: false },
      }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });
});

