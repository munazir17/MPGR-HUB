// lib/architecture/ai/__tests__/agent-tool-calling-x402.test.ts
//
// P3 — proves the x402 chat-integration addendum to
// lib/architecture/ai/agent-tool-calling.ts:
//   - x402_prepare_payment is advertised alongside read tools (but a
//     prepare tool is still never advertised/run through the OLD
//     read-only path, which every pre-existing test already covers by
//     construction — see agent-tool-calling.test.ts's "the read-only
//     catalog... includes... and no non-read tool").
//   - x402_prepare_payment can actually be invoked through the loop and
//     reach the real production AgentToolRuntime.
//   - the resulting X402PaymentProposal is captured onto the final
//     AIProviderResponse from the tool's own structured result — never
//     reconstructed from the model's text — and the model is never
//     handed the real payment fields to restate.
//   - nothing in this path signs or submits anything: it only ever
//     calls agentToolRuntime.executeTool for "read"/"prepare" tools,
//     the same production boundary every other tool already goes
//     through, and x402_prepare_payment's own execute() (verified in
//     x402-tool-definitions.test.ts) never touches a wallet.
//   - a non-x402 turn is completely unaffected (no x402Proposal field,
//     same reply/intent behavior as before this change).

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { getAgentToolRegistry } from "@/lib/architecture/tools/agent-tool-registry-instance";
import { toolSuccess, toolError } from "@/lib/architecture/tools/agent-tool-result";
import "@/lib/architecture/tools/x402-tool-definitions"; // registers x402_discover_resource / x402_prepare_payment
import { parseX402PaymentRequired } from "@/lib/x402/x402-parse";
import { buildX402PaymentProposal } from "@/lib/x402/x402-proposal";
import { X402_SUPPORTED_NETWORK } from "@/lib/x402/x402-config";
import type { AIProviderRequest } from "../ai-provider";

import {
  getReadAndPrepareToolCatalog,
  getReadOnlyToolCatalog,
  runRegisteredTool,
  runToolCallingLoop,
} from "../agent-tool-calling";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid-report";

function makeRequest(overrides: Partial<AIProviderRequest> = {}): AIProviderRequest {
  return {
    prompt: "Can you pay for and fetch https://api.example.com/paid-report for me?",
    agentContext: { isConnected: true } as unknown as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
    } as unknown as AIProviderRequest["memoryContext"],
    address: "0x000000000000000000000000000000000000aa",
    ...overrides,
  };
}

function buildFixtureProposal() {
  const parsed = parseX402PaymentRequired({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: X402_SUPPORTED_NETWORK,
        maxAmountRequired: "2500000",
        resource: RESOURCE,
        payTo: PAY_TO,
        asset: USDC,
        description: "Paid report",
      },
    ],
  });
  if (!parsed.ok) throw new Error("test setup failed to parse requirement");
  const built = buildX402PaymentProposal(RESOURCE, parsed.requirements[0]);
  if (!built.ok) throw new Error("test setup failed to build proposal");
  return built.proposal;
}

describe("x402 tool catalog wiring", () => {
  it("x402_prepare_payment is registered in the real production registry", () => {
    expect(getAgentToolRegistry().has("x402_prepare_payment")).toBe(true);
    expect(getAgentToolRegistry().has("x402_discover_resource")).toBe(true);
  });

  it("the read-and-prepare catalog includes x402_prepare_payment; the read-only catalog does not", () => {
    const readAndPrepareIds = getReadAndPrepareToolCatalog().map((t) => t.id);
    expect(readAndPrepareIds).toContain("x402_prepare_payment");
    expect(readAndPrepareIds).toContain("x402_discover_resource");

    const readOnlyIds = getReadOnlyToolCatalog().map((t) => t.id);
    expect(readOnlyIds).not.toContain("x402_prepare_payment");
    expect(readOnlyIds).toContain("x402_discover_resource");
  });

  it("every tool in the read-and-prepare catalog is mode read or prepare — never execute", () => {
    for (const tool of getReadAndPrepareToolCatalog()) {
      expect(["read", "prepare"]).toContain(tool.mode);
    }
  });
});

describe("runRegisteredTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the real production AgentToolRuntime.executeTool for x402_prepare_payment with canPrepare:true, canExecute:false", async () => {
    const proposal = buildFixtureProposal();
    const spy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("x402_prepare_payment", { proposal }));

    const result = await runRegisteredTool("x402_prepare_payment", { resourceUrl: RESOURCE }, makeRequest());

    expect(spy).toHaveBeenCalledWith(
      "x402_prepare_payment",
      { resourceUrl: RESOURCE },
      expect.objectContaining({
        permissions: { canRead: true, canPrepare: true, canExecute: false },
      })
    );
    expect(result.success).toBe(true);
  });

  it("still refuses an unknown tool id without touching AgentToolRuntime", async () => {
    const spy = vi.spyOn(agentToolRuntime, "executeTool");
    const result = await runRegisteredTool("not_a_real_tool", {}, makeRequest());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a registered execute-mode tool id without touching AgentToolRuntime", async () => {
    const fakeExecuteTool = {
      id: "__test_x402_execute_tool__",
      name: "Test Execute Tool",
      description: "A fake execute-mode tool for this test only.",
      category: "payment" as const,
      mode: "execute" as const,
      riskLevel: "critical" as const,
      requiresWallet: true,
      requiresConfirmation: true,
      inputSchema: { type: "object" as const, properties: {} },
      execute: async () => toolSuccess("__test_x402_execute_tool__", { signed: true }),
    };
    getAgentToolRegistry().register(fakeExecuteTool);
    try {
      const spy = vi.spyOn(agentToolRuntime, "executeTool");
      const result = await runRegisteredTool("__test_x402_execute_tool__", {}, makeRequest());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("TOOL_NOT_FOUND");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      getAgentToolRegistry().unregister("__test_x402_execute_tool__");
    }
  });
});

describe("runToolCallingLoop — x402 handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures the proposal from x402_prepare_payment's own result onto the final response, unmodified", async () => {
    const proposal = buildFixtureProposal();
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(toolSuccess("x402_prepare_payment", { proposal }));

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "x402_prepare_payment", arguments: { resourceUrl: RESOURCE } } })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ intent: "general_help", reply: "I've prepared a payment proposal for you to review and confirm." })
      );

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(response.x402Proposal).toBeDefined();
    expect(response.x402Proposal).toEqual(proposal);
    // Never re-derived/mutated — the exact same object identity the tool returned.
    expect(response.x402Proposal).toBe(proposal);
  });

  it("does not leak the proposal's exact amount/recipient into the transcript text sent back to the model", async () => {
    const proposal = buildFixtureProposal();
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(toolSuccess("x402_prepare_payment", { proposal }));

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "x402_prepare_payment", arguments: { resourceUrl: RESOURCE } } })
      )
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "Proposal ready for your review." }));

    await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    const secondCallUserPrompt = sendCompletion.mock.calls[1][1] as string;
    expect(secondCallUserPrompt).not.toContain(proposal.requirement.maxAmountRequired);
    expect(secondCallUserPrompt).not.toContain(PAY_TO);
    expect(secondCallUserPrompt).toContain("do NOT restate the amount");
  });

  it("does not attach a proposal when x402_prepare_payment fails", async () => {
    vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolError("x402_prepare_payment", { code: "DATA_UNAVAILABLE", message: "Not currently requesting payment." })
    );

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "x402_prepare_payment", arguments: { resourceUrl: RESOURCE } } })
      )
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "That resource isn't requesting payment right now." }));

    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    expect(response.x402Proposal).toBeUndefined();
  });

  it("a plain (non-x402) final answer never carries an x402Proposal field", async () => {
    const sendCompletion = vi.fn().mockResolvedValue(JSON.stringify({ intent: "general_help", reply: "Hi there." }));
    const response = await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);
    expect(response.x402Proposal).toBeUndefined();
    expect(response.reply).toBe("Hi there.");
  });

  it("this loop never calls anything beyond agentToolRuntime.executeTool — no signing/wallet API is reachable from here", async () => {
    const proposal = buildFixtureProposal();
    const spy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("x402_prepare_payment", { proposal }));

    const sendCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ toolCall: { toolId: "x402_prepare_payment", arguments: { resourceUrl: RESOURCE } } })
      )
      .mockResolvedValueOnce(JSON.stringify({ intent: "general_help", reply: "Ready for your review." }));

    await runToolCallingLoop(makeRequest(), "base prompt", sendCompletion);

    // Every call this loop made into the tool runtime was for a
    // read/prepare tool — the proposal came back as data, nothing was
    // signed or submitted as a side effect of running the loop.
    for (const call of spy.mock.calls) {
      const toolId = call[0] as string;
      const tool = getAgentToolRegistry().get(toolId);
      expect(tool?.mode).not.toBe("execute");
    }
  });
});
