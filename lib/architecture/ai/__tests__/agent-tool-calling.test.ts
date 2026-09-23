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
import { toolError, toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";
import type { TransferProposal } from "@/lib/trade/transfer-types";
import type { AIProviderRequest } from "../ai-provider";
import "@/lib/architecture/tools/trade-tool-definitions";

import {
  MAX_TOOL_CALL_ROUNDS,
  buildGatedCapabilityInstructions,
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

  it("treats non-empty NVIDIA-style plaintext as a final general_help reply", () => {
    const directive = parseModelDirective("Hello! How can I help you today?", null);
    expect(directive.kind).toBe("final");
    if (directive.kind === "final") {
      expect(directive.intent).toBe("general_help");
      expect(directive.reply).toBe("Hello! How can I help you today?");
    }
  });

  it("coerces fenced JSON and preamble-embedded JSON into a directive", () => {
    const fenced = parseModelDirective(
      'Sure.\n```json\n{"intent":"general_help","reply":"Hi from NVIDIA."}\n```',
      null,
    );
    expect(fenced.kind).toBe("final");
    if (fenced.kind === "final") {
      expect(fenced.reply).toBe("Hi from NVIDIA.");
    }

    const embedded = parseModelDirective(
      'Reasoning first.\n{"intent":"general_help","reply":"Embedded works."}',
      null,
    );
    expect(embedded.kind).toBe("final");
    if (embedded.kind === "final") {
      expect(embedded.reply).toBe("Embedded works.");
    }
  });

  it("throws on empty content or empty-reply protocol JSON", () => {
    expect(() => parseModelDirective("", null)).toThrow(/missing a non-empty reply/);
    expect(() => parseModelDirective("   ", null)).toThrow(/missing a non-empty reply/);
    expect(() => parseModelDirective(JSON.stringify({ intent: "general_help", reply: "" }), null)).toThrow(
      /missing a non-empty reply/,
    );
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

  it("answers an explicit B20 order with no size by asking for the size, not with research", async () => {
    // The model researched the asset and then wrote a research-only answer
    // for an order it could not size. The loop must not hand that back as
    // the final reply (the card meanwhile advertises an execution route).
    const spy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(
        toolSuccess("tokenized_stock_research", {
          report: { kind: "catalog", assets: [{ symbol: "MSTRc" }] },
        }),
      );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "tokenized_stock_research", arguments: { symbol: "MSTRc" } } }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ intent: "general_help", reply: "Here is research on MSTRc. Research only." }),
      );

    const response = await runToolCallingLoop(
      makeRequest({ prompt: "Sell my USDC worth of MSTRc" }),
      "base prompt",
      sendCompletion,
    );

    expect(spy).toHaveBeenCalledWith(
      "tokenized_stock_research",
      { symbol: "MSTRc" },
      expect.anything(),
    );
    expect(response.reply.toLowerCase()).toContain("how much");
    // "sell my USDC worth of MSTRc" is funded by USDC, so the size question
    // is about the USDC leg — the order is a BUY of MSTRc, not a MSTRc sell.
    expect(response.reply.toLowerCase()).toContain("usdc");
    expect(response.reply.toLowerCase()).toContain("mstrc");
    expect(response.reply.toLowerCase()).toContain("spend");
    expect(response.reply).not.toContain("Research only");
    expect(response.tokenizedStockReport).toBeUndefined();
  });

  it("still returns the model's research answer for a research question", async () => {
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolSuccess("tokenized_stock_research", {
        report: { kind: "catalog", assets: [{ symbol: "MSTRc" }] },
      }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "tokenized_stock_research", arguments: { symbol: "MSTRc" } } }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ intent: "general_help", reply: "Here is research on MSTRc. Research only." }),
      );

    const response = await runToolCallingLoop(
      makeRequest({ prompt: "Check MSTRc price and oracle" }),
      "base prompt",
      sendCompletion,
    );

    expect(response.reply).toBe("Here is research on MSTRc. Research only.");
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

    const response = await runToolCallingLoop(
      makeRequest(),
      "base prompt",
      sendCompletion,
    );

    expect(sendCompletion).toHaveBeenCalledTimes(MAX_TOOL_CALL_ROUNDS);
    expect(response.reply).toContain("I finished that lookup.");
    expect(response.reply).toContain("I will not sign or submit any transaction.");
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

// Regression coverage for the MASTER TASK Part 1 fix: a failed
// transfer_prepare_send must never fall through to generic
// assistant/help text ("I can help with: Portfolio Summary...").
// See agent-tool-calling.ts's early-return checks right after
// captureTransferProposal in runToolCallingLoop.
describe("runToolCallingLoop — transfer_prepare_send error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTransferProposal(overrides: Partial<TransferProposal> = {}): TransferProposal {
    return {
      id: "transfer-test-1",
      kind: "erc20-transfer",
      network: "base",
      chainId: 8453,
      asset: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        kind: "erc20",
        verified: true,
      },
      amount: "5000000",
      sender: "0x1111111111111111111111111111111111111111" as TransferProposal["sender"],
      recipient: {
        input: "0x2222222222222222222222222222222222222222",
        inputKind: "address",
        address: "0x2222222222222222222222222222222222222222" as TransferProposal["recipient"]["address"],
        basename: null,
      },
      senderBalance: "1000000",
      sufficientBalance: false,
      transaction: { to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as TransferProposal["transaction"]["to"], data: "0x", value: "0" },
      quotedAt: new Date().toISOString(),
      risk: [],
      warnings: [],
      displayAmount: "5 USDC",
      description: "Send 5 USDC on Base to 0x2222222222222222222222222222222222222222.",
      requiresConfirmation: true,
      phase: "idle",
      ...overrides,
    };
  }

  it("returns the grounded tool error directly instead of asking the model for a free-form reply", async () => {
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolError("transfer_prepare_send", {
        code: "INVALID_INPUT",
        message: "Invalid recipient address. Nothing was sent.",
      }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          toolCall: {
            toolId: "transfer_prepare_send",
            arguments: { token: "USDC", amount: "5", recipient: "not-an-address" },
          },
        }),
      );

    const response = await runToolCallingLoop(makeRequest({ prompt: "send 5 usdc to not-an-address" }), "base prompt", sendCompletion);

    // The model is never given a second turn to paraphrase or replace
    // the grounded error with generic help text.
    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(response.reply).toBe("Invalid recipient address. Nothing was sent.");
    expect(response.reply).not.toContain("I can help with");
    expect(response.transferProposal).toBeUndefined();
  });

  it("appends 'Nothing was sent.' when the underlying tool error doesn't already say so", async () => {
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolError("transfer_prepare_send", {
        code: "DATA_UNAVAILABLE",
        message: "Could not verify USDC's on-chain decimals — refusing to guess for a real-funds transfer.",
      }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          toolCall: { toolId: "transfer_prepare_send", arguments: { token: "USDC", amount: "5", recipient: "jesse.base.eth" } },
        }),
      );

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(response.reply).toBe(
      "Could not verify USDC's on-chain decimals — refusing to guess for a real-funds transfer. Nothing was sent.",
    );
  });

  it("falls back to a generic grounded message when the tool error has no message", async () => {
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolError("transfer_prepare_send", { code: "PROVIDER_ERROR", message: "" }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "transfer_prepare_send", arguments: { token: "ETH", amount: "0.01", recipient: "0x2222222222222222222222222222222222222222" } } }),
      );

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(response.reply).toBe("Could not prepare that Base transfer. Nothing was sent. Please try again.");
  });

  it("surfaces a deterministic insufficient-balance reply and still returns the proposal for the UI card", async () => {
    const proposal = makeTransferProposal();
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolSuccess("transfer_prepare_send", { proposal }, { source: "base-erc20-transfer", chainId: 8453 }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          toolCall: { toolId: "transfer_prepare_send", arguments: { token: "USDC", amount: "5", recipient: "0x2222222222222222222222222222222222222222" } },
        }),
      );

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(response.reply).toBe("Insufficient USDC balance. You have 1 USDC, but you're trying to send 5 USDC. Nothing was sent.");
    expect(response.reply).not.toContain("ready to review");
    expect(response.transferProposal).toEqual(proposal);
  });

  it("surfaces a deterministic insufficient-ETH reply for native transfers", async () => {
    const proposal = makeTransferProposal({
      kind: "native-transfer",
      asset: {
        address: "0x0000000000000000000000000000000000EeEe" as TransferProposal["asset"]["address"],
        symbol: "ETH",
        name: "Ether",
        decimals: 18,
        kind: "native",
        verified: true,
      },
      amount: "10000000000000000",
      senderBalance: "1000000000000000",
      displayAmount: "0.01 ETH",
    });
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolSuccess("transfer_prepare_send", { proposal }, { source: "base-native-transfer", chainId: 8453 }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          toolCall: { toolId: "transfer_prepare_send", arguments: { token: "ETH", amount: "0.01", recipient: "0x2222222222222222222222222222222222222222" } },
        }),
      );

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(response.reply).toContain("Insufficient ETH balance.");
    expect(response.reply).toContain("network fees");
    expect(response.transferProposal).toEqual(proposal);
  });

  it("still lets the model give the final reply when the transfer proposal has sufficient balance", async () => {
    const proposal = makeTransferProposal({ sufficientBalance: true, senderBalance: "50000000" });
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolSuccess("transfer_prepare_send", { proposal }, { source: "base-erc20-transfer", chainId: 8453 }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          toolCall: { toolId: "transfer_prepare_send", arguments: { token: "USDC", amount: "5", recipient: "0x2222222222222222222222222222222222222222" } },
        }),
      )
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "Review the proposal and confirm to send." }));

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(sendCompletion).toHaveBeenCalledTimes(2);
    expect(response.reply).toBe("Review the proposal and confirm to send.");
    expect(response.transferProposal).toEqual(proposal);
  });
});

describe("plaintext NVIDIA/Gemini success does not throw into OpenAI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the NVIDIA prose as the assistant reply and never requests another completion", async () => {
    const sendCompletion = vi.fn().mockResolvedValue("Hello! How can I help you in MPGR HUB today?");
    const response = await runToolCallingLoop(
      makeRequest({ prompt: "hi" }),
      "base prompt",
      sendCompletion,
    );
    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(response.reply).toBe("Hello! How can I help you in MPGR HUB today?");
    expect(response.intent).toBe("general_help");
    expect(response.tradeProposal).toBeUndefined();
  });
});

describe("AAPLc buy confirmation when the model skips the prepare tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("force-prepares a requiresConfirmation proposal and never executes", async () => {
    const proposal = {
      id: "b20_aaplc_buy",
      requiresConfirmation: true,
      network: "base",
      kind: "tokenized-stock-swap",
      provider: "aerodrome-slipstream",
      fromAmount: "5000000",
    };
    const executeSpy = vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolSuccess("tokenized_stock_prepare_order", { proposal }),
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ intent: "general_help", reply: "Buying AAPLc now." }));

    const response = await runToolCallingLoop(
      makeRequest({ prompt: "buy $5 AAPLc" }),
      "base prompt",
      sendCompletion,
    );

    expect(sendCompletion).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[0]).toBe("tokenized_stock_prepare_order");
    expect(executeSpy.mock.calls[0]?.[1]).toEqual({
      symbol: "AAPLc",
      amount: "5",
      side: "BUY",
      amountUnit: "usd",
    });
    expect(executeSpy.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        permissions: { canRead: true, canPrepare: true, canExecute: false },
      }),
    );
    expect(executeSpy.mock.calls[0]?.[0]).not.toMatch(/execute|submit|broadcast|sign/i);
    expect(response.tradeProposal).toEqual(proposal);
    expect(response.tradeProposal?.requiresConfirmation).toBe(true);
    expect(response.reply.toLowerCase()).toContain("explicitly confirm");
    expect(response.reply.toLowerCase()).toMatch(/nothing is signed|will not sign/);
  });

  it("does not force-prepare a simple hi", async () => {
    const executeSpy = vi.spyOn(agentToolRuntime, "executeTool");
    const sendCompletion = vi.fn().mockResolvedValue("hey");
    const response = await runToolCallingLoop(makeRequest({ prompt: "hi" }), "base prompt", sendCompletion);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(response.tradeProposal).toBeUndefined();
    expect(response.reply).toBe("hey");
  });
});

describe("buildGatedCapabilityInstructions", () => {
  it("omits trading/x402 essays for simple chat", () => {
    const text = buildGatedCapabilityInstructions("hi").join("\n");
    expect(text).toBe("");
    expect(text).not.toContain("tokenized_stock_prepare_order");
    expect(text).not.toContain("x402_prepare_payment");
    expect(text).not.toContain("trade_prepare_swap");
    expect(text).not.toContain("x402_discover_resource");
  });

  it("keeps B20 prepare safety text for buy $5 AAPLc", () => {
    const text = buildGatedCapabilityInstructions("buy $5 AAPLc").join("\n");
    expect(text).toContain("tokenized_stock_prepare_order");
    expect(text).toContain("Never call trade_prepare_swap for AAPL/AAPLc");
    expect(text).toContain("never sign or broadcast");
    expect(text).not.toContain("x402_prepare_payment");
  });

  it("keeps x402 essays only for x402 prompts", () => {
    const text = buildGatedCapabilityInstructions(
      "Prepare a payment proposal for this x402 resource: https://x402-demo-discovery-endpoint.vercel.app/protected",
    ).join("\n");
    expect(text).toContain("x402_prepare_payment");
    expect(text).toContain("never signs or submits a payment");
    expect(text).not.toContain("tokenized_stock_prepare_order");
  });
});
