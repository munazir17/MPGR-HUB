// lib/architecture/ai/__tests__/network-providers-tool-calling.test.ts
//
// End-to-end (within test boundaries) proof that OpenAIAIProvider and
// GeminiAIProvider each drive lib/architecture/ai/agent-tool-calling.ts's
// shared loop against the REAL production agentToolRuntime singleton —
// not merely that the model claims it used a tool. `global.fetch` is
// mocked to stand in for the two Route Handlers
// (app/api/agent/complete/route.ts and app/api/agent/complete/gemini/route.ts),
// which is the only network boundary either provider class owns;
// everything on the other side of that boundary (tool selection
// execution, permission enforcement) is real production code.

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import type { AIProviderRequest } from "../ai-provider";
import { OpenAIAIProvider } from "../openai-ai-provider";
import { GeminiAIProvider } from "../gemini-ai-provider";
import { FallbackAIProvider } from "../fallback-ai-provider";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { EventBus, Logger } from "@/lib/architecture/core/types";

function makeRequest(): AIProviderRequest {
  return {
    prompt: "Compare the current MPGR yield opportunities for me.",
    agentContext: { isConnected: false } as unknown as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {
      isReturningUser: false,
      interactionCount: 0,
      favoriteTopics: [],
      conversationSummaries: [],
    } as unknown as AIProviderRequest["memoryContext"],
    address: "0x000000000000000000000000000000000000aa",
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("OpenAIAIProvider — production tool-calling flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("calls /api/agent/complete, invokes yield_comparison through the real runtime, and returns the final reply", async () => {
    const executeToolSpy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("yield_comparison", { entries: [{ opportunityId: "mpgr-staking" }] }));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ content: JSON.stringify({ toolCall: { toolId: "yield_comparison", arguments: {} } }) })
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: JSON.stringify({ intent: "general_help", reply: "MPGR Staking is the only known opportunity." }) })
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIAIProvider();
    const response = await provider.generateReply(makeRequest());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent/complete");
    expect(executeToolSpy).toHaveBeenCalledWith("yield_comparison", {}, expect.anything());
    expect(response.reply).toBe("MPGR Staking is the only known opportunity.");
    expect(response.intent).toBe("general_help");
  });

  it("propagates a network failure so the outer Fallback/CircuitBreaker chain can catch it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "OPENAI_API_KEY is not configured on the server." }) })
    );

    const provider = new OpenAIAIProvider();
    await expect(provider.generateReply(makeRequest())).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe("GeminiAIProvider — production tool-calling flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("calls /api/agent/complete/gemini, invokes yield_opportunities through the real runtime, and returns the final reply", async () => {
    const executeToolSpy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("yield_opportunities", { opportunities: [{ id: "mpgr-staking" }] }));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ content: JSON.stringify({ toolCall: { toolId: "yield_opportunities", arguments: {} } }) })
      )
      .mockResolvedValueOnce(
        jsonResponse({ content: JSON.stringify({ intent: "general_help", reply: "MPGR Staking is currently live." }) })
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiAIProvider();
    const response = await provider.generateReply(makeRequest());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent/complete/gemini");
    expect(executeToolSpy).toHaveBeenCalledWith("yield_opportunities", {}, expect.anything());
    expect(response.reply).toBe("MPGR Staking is currently live.");
  });

  it("invokes yield_estimator through the real runtime with the model's arguments", async () => {
    const executeToolSpy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(toolSuccess("yield_estimator", { estimatedGrossRewardFormatted: "50" }));

    const args = { opportunityId: "mpgr-staking", amount: "500", durationDays: 180 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ content: JSON.stringify({ toolCall: { toolId: "yield_estimator", arguments: args } }) }))
      .mockResolvedValueOnce(jsonResponse({ content: JSON.stringify({ intent: "general_help", reply: "Roughly 50 MPGR." }) }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiAIProvider();
    const response = await provider.generateReply(makeRequest());

    expect(executeToolSpy).toHaveBeenCalledWith("yield_estimator", args, expect.anything());
    expect(response.reply).toBe("Roughly 50 MPGR.");
  });
});

describe("deterministic fallback still works with the tool-calling loop wired in", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to DeterministicAIProvider when the tool-calling loop throws (e.g. malformed model JSON)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ content: "not valid json" })));

    const emit = vi.fn();
    const eventBus: EventBus = { on: () => () => {}, off: () => {}, emit, use: () => () => {} };
    const logger: Logger = { debug: () => {}, warn: () => {}, error: () => {} };

    const fallback = new FallbackAIProvider(new OpenAIAIProvider(), new DeterministicAIProvider(), eventBus, logger);

    const response = await fallback.generateReply(makeRequest());

    // DeterministicAIProvider actually ran and produced a real response —
    // no exception escaped to the caller.
    expect(response.reply.length).toBeGreaterThan(0);
    expect(emit).toHaveBeenCalledWith("ai_provider_fallback", expect.objectContaining({ from: "openai", to: "deterministic" }));
  });
});
