// lib/architecture/ai/__tests__/agent-tool-calling.test.ts
//
// Proves the thing that was missing before this change: a natural-
// language Agent request can actually reach
// AgentToolRuntime.executeTool("yield_opportunities" | "yield_estimator" |
// "yield_comparison", ...) through the real production registry/runtime
// singletons (agent-tool-registry-instance.ts / agent-tool-runtime-instance.ts)
// — not just through a unit test that builds its own throwaway registry
// (see p2-tool-definitions.test.ts, which does exactly that and therefore
// never exercised whether these tools were reachable in production).
//
// Where a test needs to prove "the production runtime was actually
// called with this toolId", it spies on the real `agentToolRuntime`
// singleton's `executeTool` method rather than mocking it away entirely
// — the spy's mock implementation still returns a well-formed
// AgentToolResult, but the assertion is on the exact call the loop made
// into the real, shared instance every other part of the app uses.
// Where a test doesn't need network-backed data (invalid input, unknown
// tool, permission denial), it lets the real registry/runtime run
// unmocked — those paths reject before any RPC call happens (schema
// validation and permission checks both run before tool.execute()).

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { getAgentToolRegistry } from "@/lib/architecture/tools/agent-tool-registry-instance";
import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";
import type { AIProviderRequest } from "../ai-provider";

import {
  MAX_TOOL_CALL_ROUNDS,
  buildToolCatalogPromptBlock,
  getReadOnlyToolCatalog,
  parseModelDirective,
  runRegisteredReadTool,
  runToolCallingLoop,
} from "../agent-tool-calling";

function makeRequest(overrides: Partial<AIProviderRequest> = {}): AIProviderRequest {
  return {
    prompt: "What yield opportunities exist?",
    agentContext: { isConnected: false } as unknown as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
    } as unknown as AIProviderRequest["memoryContext"],
    ...overrides,
  };
}

describe("production registry wiring", () => {
  it("registers all three P2 yield tools into the real production registry", () => {
    const registry = getAgentToolRegistry();
    expect(registry.has("yield_opportunities")).toBe(true);
    expect(registry.has("yield_estimator")).toBe(true);
    expect(registry.has("yield_comparison")).toBe(true);
  });

  it("existing P0.2 read tools are still registered alongside P2", () => {
    const registry = getAgentToolRegistry();
    for (const id of ["wallet_analyzer", "token_analyzer", "portfolio_analyzer", "base_research", "market_intelligence"]) {
      expect(registry.has(id)).toBe(true);
    }
  });

  it("the read-only catalog advertised to models includes every P2 tool and no non-read tool", () => {
    const catalog = getReadOnlyToolCatalog();
    const ids = catalog.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["yield_opportunities", "yield_estimator", "yield_comparison"]));
    for (const tool of catalog) {
      expect(tool.mode).toBe("read");
    }
  });

  it("the prompt block lists every advertised tool's id and schema", () => {
    const block = buildToolCatalogPromptBlock(getReadOnlyToolCatalog());
    expect(block).toContain("yield_opportunities");
    expect(block).toContain("yield_estimator");
    expect(block).toContain("yield_comparison");
    expect(block).toContain("toolCall");
  });
});

describe("parseModelDirective", () => {
  it("parses a tool-call directive", () => {
    const directive = parseModelDirective(
      JSON.stringify({ toolCall: { toolId: "yield_opportunities", arguments: { opportunityId: "mpgr-staking" } } }),
      null
    );
    expect(directive.kind).toBe("tool_call");
    if (directive.kind === "tool_call") {
      expect(directive.toolId).toBe("yield_opportunities");
      expect(directive.arguments).toEqual({ opportunityId: "mpgr-staking" });
    }
  });

  it("parses a final-answer directive", () => {
    const directive = parseModelDirective(JSON.stringify({ intent: "general_help", reply: "Here you go." }), null);
    expect(directive.kind).toBe("final");
    if (directive.kind === "final") {
      expect(directive.reply).toBe("Here you go.");
    }
  });

  it("falls back to previousIntent when intent is missing/invalid", () => {
    const directive = parseModelDirective(JSON.stringify({ reply: "ok" }), "portfolio_summary" as never);
    if (directive.kind === "final") {
      expect(directive.intent).toBe("portfolio_summary");
    } else {
      throw new Error("expected a final directive");
    }
  });

  it("throws on invalid JSON", () => {
    expect(() => parseModelDirective("not json", null)).toThrow();
  });

  it("throws when neither a tool call nor a non-empty reply is present", () => {
    expect(() => parseModelDirective(JSON.stringify({ intent: "general_help", reply: "" }), null)).toThrow();
  });
});

describe("runRegisteredReadTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getAgentToolRegistry().unregister("__test_prepare_tool__");
  });

  it("rejects an unknown tool id without touching AgentToolRuntime", async () => {
    const spy = vi.spyOn(agentToolRuntime, "executeTool");
    const result = await runRegisteredReadTool("not_a_real_tool", {}, makeRequest());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a registered non-read tool id without touching AgentToolRuntime", async () => {
    const fakePrepareTool: AnyAgentTool = {
      id: "__test_prepare_tool__",
      name: "Test Prepare Tool",
      description: "A fake prepare-mode tool for this test only.",
      category: "defi",
      mode: "prepare",
      riskLevel: "medium",
      requiresWallet: false,
      requiresConfirmation: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => toolSuccess("__test_prepare_tool__", {}),
    };
    getAgentToolRegistry().register(fakePrepareTool);

    const spy = vi.spyOn(agentToolRuntime, "executeTool");
    const result = await runRegisteredReadTool("__test_prepare_tool__", {}, makeRequest());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments for a real registered tool before any provider access", async () => {
    // yield_estimator requires opportunityId/amount/durationDays — schema
    // validation runs inside AgentToolRuntime before tool.execute(), so
    // this never reaches a network/staking-service call.
    const result = await runRegisteredReadTool("yield_estimator", {}, makeRequest());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("invokes the real production AgentToolRuntime.executeTool for a valid read tool call", async () => {
    const spy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("yield_opportunities", { opportunities: [] }));

    const result = await runRegisteredReadTool("yield_opportunities", {}, makeRequest());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      "yield_opportunities",
      {},
      expect.objectContaining({
        permissions: { canRead: true, canPrepare: false, canExecute: false },
      })
    );
    expect(result.success).toBe(true);
  });

  it("read permission denial from the real runtime is preserved end to end", async () => {
    // Calls the real production instance directly (not through
    // runRegisteredReadTool, which always sets canRead:true) to prove the
    // underlying permission gate this loop relies on is still authoritative.
    const result = await agentToolRuntime.executeTool(
      "yield_opportunities",
      {},
      { requestId: "perm-test", confirmationMode: "always_confirm", permissions: { canRead: false, canPrepare: true, canExecute: true } }
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
  });

  it("execute-mode tools remain unconditionally refused by the real runtime regardless of permissions", async () => {
    const fakeExecuteTool: AnyAgentTool = {
      id: "__test_execute_tool__",
      name: "Test Execute Tool",
      description: "A fake execute-mode tool for this test only.",
      category: "execution",
      mode: "execute",
      riskLevel: "critical",
      requiresWallet: true,
      requiresConfirmation: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => toolSuccess("__test_execute_tool__", { txHash: "0xshould-never-run" }),
    };
    getAgentToolRegistry().register(fakeExecuteTool);
    try {
      const result = await agentToolRuntime.executeTool(
        "__test_execute_tool__",
        {},
        { requestId: "exec-test", confirmationMode: "always_confirm", permissions: { canRead: true, canPrepare: true, canExecute: true } }
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("EXECUTION_NOT_ALLOWED");
    } finally {
      getAgentToolRegistry().unregister("__test_execute_tool__");
    }
  });
});

describe("runToolCallingLoop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a final answer directly when the model doesn't request a tool", async () => {
    const sendCompletion = vi.fn().mockResolvedValue(JSON.stringify({ intent: "general_help", reply: "Hi there." }));
    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);
    expect(response.reply).toBe("Hi there.");
    expect(sendCompletion).toHaveBeenCalledTimes(1);
  });

  it("executes yield_opportunities through the real runtime, then returns the model's final answer", async () => {
    const spy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("yield_opportunities", { opportunities: [{ id: "mpgr-staking" }] }));

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ toolCall: { toolId: "yield_opportunities", arguments: {} } }))
      .mockResolvedValueOnce(JSON.stringify({ intent: "portfolio_summary", reply: "MPGR Staking is currently available." }));

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(spy).toHaveBeenCalledWith("yield_opportunities", {}, expect.anything());
    expect(sendCompletion).toHaveBeenCalledTimes(2);
    expect(response.reply).toBe("MPGR Staking is currently available.");
  });

  it("executes yield_estimator through the real runtime", async () => {
    const spy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("yield_estimator", { estimatedGrossRewardFormatted: "100" }));

    const args = { opportunityId: "mpgr-staking", amount: "1000", durationDays: 365 };
    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ toolCall: { toolId: "yield_estimator", arguments: args } }))
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "About 100 MPGR over a year." }));

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(spy).toHaveBeenCalledWith("yield_estimator", args, expect.anything());
    expect(response.reply).toBe("About 100 MPGR over a year.");
  });

  it("executes yield_comparison through the real runtime", async () => {
    const spy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("yield_comparison", { entries: [] }));

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ toolCall: { toolId: "yield_comparison", arguments: {} } }))
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "Only MPGR Staking is currently known." }));

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(spy).toHaveBeenCalledWith("yield_comparison", {}, expect.anything());
    expect(response.reply).toBe("Only MPGR Staking is currently known.");
  });

  it("folds an unknown tool id back into the transcript instead of crashing", async () => {
    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ toolCall: { toolId: "not_a_real_tool", arguments: {} } }))
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "I couldn't find that tool, but here's what I know." }));

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(response.reply).toBe("I couldn't find that tool, but here's what I know.");
    const secondCallUserPrompt = sendCompletion.mock.calls[1][1] as string;
    expect(secondCallUserPrompt).toContain("TOOL_NOT_FOUND");
  });

  it("bounds the loop at MAX_TOOL_CALL_ROUNDS and never calls the model more than that", async () => {
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(toolSuccess("yield_opportunities", { opportunities: [] }));

    const sendCompletion = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ toolCall: { toolId: "yield_opportunities", arguments: {} } }));

    await expect(runToolCallingLoop(makeRequest(), "base prompt", sendCompletion)).rejects.toThrow();
    expect(sendCompletion).toHaveBeenCalledTimes(MAX_TOOL_CALL_ROUNDS);
  });

  it("never leaks a raw provider error message into the transcript sent back to the model", async () => {
    vi.spyOn(agentToolRuntime, "executeTool").mockRejectedValue(new Error("SUPER_SECRET_INTERNAL_DETAIL"));

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ toolCall: { toolId: "yield_opportunities", arguments: {} } }))
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "Something went wrong, but here's what I can say." }));

    // agentToolRuntime.executeTool itself never lets a thrown error escape
    // (see agent-tool-runtime.ts's catch block) — it resolves with a
    // sanitized PROVIDER_ERROR result instead, so mocking a throw here
    // exercises runRegisteredReadTool's pass-through of that behavior.
    await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    const secondCallUserPrompt = sendCompletion.mock.calls[1][1] as string;
    expect(secondCallUserPrompt).not.toContain("SUPER_SECRET_INTERNAL_DETAIL");
  });
});
