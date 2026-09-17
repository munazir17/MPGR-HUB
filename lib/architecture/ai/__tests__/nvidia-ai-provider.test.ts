import { afterEach, describe, expect, it, vi } from "vitest";

import { createAIProvider } from "../ai-provider-factory";
import {
  isProviderKindImplemented,
  resolveConfiguredProviderKind,
} from "../ai-provider-config";
import { NvidiaAIProvider, sendCompletion } from "../nvidia-ai-provider";
import { DeterministicAIProvider } from "../deterministic-ai-provider";
import { OpenAIAIProvider } from "../openai-ai-provider";
import { GeminiAIProvider } from "../gemini-ai-provider";
import { ProviderChainAIProvider } from "../ai-provider-router";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "../ai-provider";
import type { EventBus, Logger } from "@/lib/architecture/core/types";
import { agentToolRuntime } from "@/lib/architecture/tools/agent-tool-runtime-instance";
import { toolSuccess } from "@/lib/architecture/tools/agent-tool-result";

function fakeBus(): EventBus {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as EventBus;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRequest(prompt = "What is MPGR HUB?"): AIProviderRequest {
  return {
    prompt,
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

const emptyReply: AIProviderResponse = {
  intent: "general_help",
  reply: "ok",
  actions: [],
  highlights: [],
  followUps: [],
};

describe("NVIDIA provider factory and config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("instantiates the NVIDIA provider without requiring NVIDIA_API_KEY on the client", () => {
    vi.stubEnv("NVIDIA_API_KEY", "test-nvidia-key-not-for-production");
    const provider = createAIProvider("nvidia");
    expect(provider).toBeInstanceOf(NvidiaAIProvider);
    expect(provider.name).toBe("nvidia");
    expect(provider.requiresNetwork).toBe(true);
  });

  it("still instantiates NVIDIA when the key is missing — skip happens on the server route", () => {
    vi.stubEnv("NVIDIA_API_KEY", "");
    expect(createAIProvider("nvidia")).toBeInstanceOf(NvidiaAIProvider);
  });

  it("keeps Gemini as the default primary", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_PROVIDER", "");
    expect(resolveConfiguredProviderKind()).toBe("gemini");
    expect(createAIProvider(resolveConfiguredProviderKind())).toBeInstanceOf(GeminiAIProvider);
    expect(isProviderKindImplemented("nvidia")).toBe(true);
  });
});

describe("NvidiaAIProvider sendCompletion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls the same-origin NVIDIA complete route with tools, never an API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: JSON.stringify({ intent: "general_help", reply: "hi" }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const content = await sendCompletion("sys", "user question");
    expect(content).toContain("hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agent/complete/nvidia");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      systemPrompt: string;
      userPrompt: string;
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.systemPrompt).toBe("sys");
    expect(body.userPrompt).toBe("user question");
    expect(body.tools.some((tool) => tool.function.name === "tokenized_stock_prepare_order")).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toMatch(/NVIDIA_API_KEY|nvapi-|Bearer /);
  });

  it("surfaces a missing-key 503 so the chain can skip NVIDIA", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          error: "NVIDIA_API_KEY is not configured on the server.",
          code: "PROVIDER_UNREACHABLE",
        }),
      }),
    );
    await expect(sendCompletion("sys", "user")).rejects.toThrow(/NVIDIA_API_KEY is not configured/);
  });
});

describe("NvidiaAIProvider tool-calling loop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("executes a converted tool call through the real runtime and never signs", async () => {
    const executeToolSpy = vi.spyOn(agentToolRuntime, "executeTool").mockResolvedValue(
      toolSuccess("tokenized_stock_research", { report: { kind: "catalog", assets: [] } }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: JSON.stringify({
            toolCall: { toolId: "tokenized_stock_research", arguments: { symbol: "AAPL" } },
          }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: JSON.stringify({
            intent: "research_query",
            reply: "AAPLc is in the Coinbase B20 catalog.",
          }),
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new NvidiaAIProvider();
    const response = await provider.generateReply(makeRequest("Research tokenized AAPL"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/agent/complete/nvidia");
    expect(executeToolSpy).toHaveBeenCalledWith(
      "tokenized_stock_research",
      expect.objectContaining({ symbol: "AAPL" }),
      expect.objectContaining({
        permissions: { canRead: true, canPrepare: true, canExecute: false },
      }),
    );
    expect(response.reply).toContain("AAPLc");
    expect(response.intent).toBe("research_query");
  });
});

describe("Gemini → NVIDIA → OpenAI → deterministic chain", () => {
  it("falls back Gemini → NVIDIA → OpenAI → deterministic", async () => {
    const gemini: AIProvider = {
      name: "gemini",
      requiresNetwork: true,
      generateReply: vi.fn().mockRejectedValue(new Error("429 RESOURCE_EXHAUSTED")),
    };
    const nvidia: AIProvider = {
      name: "nvidia",
      requiresNetwork: true,
      generateReply: vi.fn().mockRejectedValue(new Error("NVIDIA_API_KEY is not configured")),
    };
    const openai: AIProvider = {
      name: "openai",
      requiresNetwork: true,
      generateReply: vi.fn().mockRejectedValue(new Error("OPENAI_API_KEY is not configured")),
    };
    const deterministic = {
      name: "deterministic",
      requiresNetwork: false,
      generateReply: vi.fn().mockResolvedValue({ ...emptyReply, reply: "on-device" }),
    } satisfies AIProvider;

    const chain = new ProviderChainAIProvider(
      [gemini, nvidia, openai, deterministic],
      fakeBus(),
      fakeLogger(),
    );
    const result = await chain.generateReply(makeRequest());
    expect(result.reply).toBe("on-device");
    expect(gemini.generateReply).toHaveBeenCalledOnce();
    expect(nvidia.generateReply).toHaveBeenCalledOnce();
    expect(openai.generateReply).toHaveBeenCalledOnce();
    expect(deterministic.generateReply).toHaveBeenCalledOnce();
  });

  it("uses NVIDIA when Gemini fails and NVIDIA succeeds", async () => {
    const gemini: AIProvider = {
      name: "gemini",
      requiresNetwork: true,
      generateReply: vi.fn().mockRejectedValue(new Error("Gemini is temporarily unavailable.")),
    };
    const nvidia: AIProvider = {
      name: "nvidia",
      requiresNetwork: true,
      generateReply: vi.fn().mockResolvedValue({ ...emptyReply, reply: "from nvidia" }),
    };
    const openai: AIProvider = {
      name: "openai",
      requiresNetwork: true,
      generateReply: vi.fn().mockResolvedValue({ ...emptyReply, reply: "from openai" }),
    };
    const chain = new ProviderChainAIProvider([gemini, nvidia, openai], fakeBus(), fakeLogger());
    const result = await chain.generateReply(makeRequest());
    expect(result.reply).toBe("from nvidia");
    expect(openai.generateReply).not.toHaveBeenCalled();
  });

  it("uses OpenAI when Gemini and NVIDIA fail", async () => {
    const gemini: AIProvider = {
      name: "gemini",
      requiresNetwork: true,
      generateReply: vi.fn().mockRejectedValue(new Error("gemini down")),
    };
    const nvidia: AIProvider = {
      name: "nvidia",
      requiresNetwork: true,
      generateReply: vi.fn().mockRejectedValue(new Error("nvidia down")),
    };
    const openai: AIProvider = {
      name: "openai",
      requiresNetwork: true,
      generateReply: vi.fn().mockResolvedValue({ ...emptyReply, reply: "from openai" }),
    };
    const chain = new ProviderChainAIProvider([gemini, nvidia, openai], fakeBus(), fakeLogger());
    const result = await chain.generateReply(makeRequest());
    expect(result.reply).toBe("from openai");
    expect(createAIProvider("openai")).toBeInstanceOf(OpenAIAIProvider);
    expect(createAIProvider("deterministic")).toBeInstanceOf(DeterministicAIProvider);
  });
});
