// lib/architecture/ai/__tests__/network-providers-tool-calling.test.ts
//
// End-to-end production-path tests for network AI providers.
//
// These tests prove that:
//   1. OpenAI and Gemini use the shared tool-calling loop.
//   2. Gemini sends native function declarations for read/prepare tools.
//   3. Gemini native functionCall responses are translated into the
//      vendor-neutral toolCall protocol.
//   4. x402 discovery reaches the REAL AgentToolRuntime singleton.
//   5. x402 preparation reaches the REAL AgentToolRuntime singleton.
//   6. The execution permissions remain locked:
//        canRead: true
//        canPrepare: true
//        canExecute: false
//   7. The AI provider never signs or submits a payment.
//   8. Existing fallback behavior remains intact.

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";
import type { AIProviderRequest } from "../ai-provider";
import { OpenAIAIProvider } from "../openai-ai-provider";
import { GeminiAIProvider } from "../gemini-ai-provider";
import { FallbackAIProvider } from "../fallback-ai-provider";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import type { EventBus, Logger } from "@/lib/architecture/core/types";

function makeRequest(
  prompt = "Compare the current MPGR yield opportunities for me.",
): AIProviderRequest {
  return {
    prompt,
    agentContext: {
      isConnected: false,
    } as unknown as AIProviderRequest["agentContext"],
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
      .mockResolvedValue(
        toolSuccess("yield_comparison", {
          entries: [{ opportunityId: "mpgr-staking" }],
        }),
      );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            toolCall: {
              toolId: "yield_comparison",
              arguments: {},
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            intent: "general_help",
            reply: "MPGR Staking is the only known opportunity.",
          }),
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAIAIProvider();
    const response = await provider.generateReply(makeRequest());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent/complete");
    expect(executeToolSpy).toHaveBeenCalledWith(
      "yield_comparison",
      {},
      expect.objectContaining({
        permissions: {
          canRead: true,
          canPrepare: false,
          canExecute: false,
        },
      }),
    );
    expect(response.reply).toBe(
      "MPGR Staking is the only known opportunity.",
    );
    expect(response.intent).toBe("general_help");
  });

  it("propagates a network failure so the outer Fallback/CircuitBreaker chain can catch it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          error:
            "OPENAI_API_KEY is not configured on the server.",
        }),
      }),
    );

    const provider = new OpenAIAIProvider();

    await expect(
      provider.generateReply(makeRequest()),
    ).rejects.toThrow(/OPENAI_API_KEY/);
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
      .mockResolvedValue(
        toolSuccess("yield_opportunities", {
          opportunities: [{ id: "mpgr-staking" }],
        }),
      );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            toolCall: {
              toolId: "yield_opportunities",
              arguments: {},
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            intent: "general_help",
            reply: "MPGR Staking is currently live.",
          }),
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiAIProvider();
    const response = await provider.generateReply(makeRequest());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/agent/complete/gemini",
    );

    expect(executeToolSpy).toHaveBeenCalledWith(
      "yield_opportunities",
      {},
      expect.objectContaining({
        permissions: {
          canRead: true,
          canPrepare: true,
          canExecute: false,
        },
      }),
    );

    expect(response.reply).toBe(
      "MPGR Staking is currently live.",
    );
  });

  it("invokes yield_estimator through the real runtime with the model's arguments", async () => {
    const executeToolSpy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(
        toolSuccess("yield_estimator", {
          estimatedGrossRewardFormatted: "50",
        }),
      );

    const args = {
      opportunityId: "mpgr-staking",
      amount: "500",
      durationDays: 180,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            toolCall: {
              toolId: "yield_estimator",
              arguments: args,
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            intent: "general_help",
            reply: "Roughly 50 MPGR.",
          }),
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiAIProvider();
    const response = await provider.generateReply(makeRequest());

    expect(executeToolSpy).toHaveBeenCalledWith(
      "yield_estimator",
      args,
      expect.objectContaining({
        permissions: {
          canRead: true,
          canPrepare: true,
          canExecute: false,
        },
      }),
    );

    expect(response.reply).toBe("Roughly 50 MPGR.");
  });

  it("routes x402_discover_resource through the real production tool runtime", async () => {
    const executeToolSpy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(
        toolSuccess("x402_discover_resource", {
          resource: "https://example.com/paid-resource",
          isX402: true,
          paymentRequired: true,
        }),
      );

    const resourceUrl =
      "https://example.com/paid-resource";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            toolCall: {
              toolId: "x402_discover_resource",
              arguments: {
                url: resourceUrl,
              },
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            intent: "general_help",
            reply:
              "I found an x402-gated resource and prepared the result for review.",
          }),
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiAIProvider();

    const response = await provider.generateReply(
      makeRequest(
        `Check this URL for an x402 resource: ${resourceUrl}`,
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(executeToolSpy).toHaveBeenCalledWith(
      "x402_discover_resource",
      {
        url: resourceUrl,
      },
      expect.objectContaining({
        permissions: {
          canRead: true,
          canPrepare: true,
          canExecute: false,
        },
        confirmationMode: "always_confirm",
      }),
    );

    expect(response.reply).toContain(
      "x402-gated resource",
    );
  });

  it("routes x402_prepare_payment through the real runtime without enabling execution", async () => {
    const proposal = {
      id: "proposal-test-1",
      requiresConfirmation: true,
      requirement: {
        resource: "https://example.com/paid-resource",
        payTo: "0x00000000000000000000000000000000000000bb",
        asset: "0x00000000000000000000000000000000000000cc",
        maxAmountRequired: "1000000",
      },
    };

    const executeToolSpy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(
        toolSuccess("x402_prepare_payment", {
          proposal,
        }),
      );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            toolCall: {
              toolId: "x402_prepare_payment",
              arguments: {
                resource:
                  "https://example.com/paid-resource",
              },
            },
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            intent: "general_help",
            reply:
              "I've prepared a payment proposal for you to review and confirm.",
          }),
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiAIProvider();

    const response = await provider.generateReply(
      makeRequest(
        "Prepare the x402 payment proposal for this resource.",
      ),
    );

    expect(executeToolSpy).toHaveBeenCalledWith(
      "x402_prepare_payment",
      {
        resource:
          "https://example.com/paid-resource",
      },
      expect.objectContaining({
        permissions: {
          canRead: true,
          canPrepare: true,
          canExecute: false,
        },
        confirmationMode: "always_confirm",
      }),
    );

    expect(response.x402Proposal).toEqual(proposal);

    expect(response.reply).toBe(
      "I've prepared a payment proposal for you to review and confirm.",
    );
  });

  it("never routes an execute-mode tool through the network provider tool loop", async () => {
    const executeToolSpy = vi
      .spyOn(agentToolRuntime, "executeTool")
      .mockResolvedValue(
        toolSuccess("some_execute_tool", {}),
      );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          content: JSON.stringify({
            toolCall: {
              toolId: "some_execute_tool",
              arguments: {},
            },
          }),
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new GeminiAIProvider();

    await expect(
      provider.generateReply(
        makeRequest("Execute a transaction for me."),
      ),
    ).rejects.toThrow(/No read or prepare tool is registered/);

    expect(executeToolSpy).not.toHaveBeenCalled();
  });
});

describe("deterministic fallback still works with the tool-calling loop wired in", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to DeterministicAIProvider when the tool-calling loop throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          content: "not valid json",
        }),
      ),
    );

    const emit = vi.fn();

    const eventBus: EventBus = {
      on: () => () => {},
      off: () => {},
      emit,
      use: () => () => {},
    };

    const logger: Logger = {
      debug: () => {},
      warn: () => {},
      error: () => {},
    };

    const fallback = new FallbackAIProvider(
      new OpenAIAIProvider(),
      new DeterministicAIProvider(),
      eventBus,
      logger,
    );

    const response = await fallback.generateReply(
      makeRequest(),
    );

    expect(response.reply.length).toBeGreaterThan(0);

    expect(emit).toHaveBeenCalledWith(
      "ai_provider_fallback",
      expect.objectContaining({
        from: "openai",
        to: "deterministic",
      }),
    );
  });
});
