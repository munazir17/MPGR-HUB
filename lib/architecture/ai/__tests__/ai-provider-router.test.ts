import { describe, expect, it, vi } from "vitest";
import {
  ProviderChainAIProvider,
  classifyAgentTask,
  isRateLimitMessage,
  resolveProviderKindOrder,
} from "../ai-provider-router";
import type { AIProvider, AIProviderRequest, AIProviderResponse } from "../ai-provider";
import type { EventBus, Logger } from "@/lib/architecture/core/types";
import { TimeoutAIProvider, AIProviderTimeoutError } from "../ai-provider-timeout";

function fakeBus(): EventBus {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as EventBus;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function request(prompt: string): AIProviderRequest {
  return {
    prompt,
    agentContext: {} as AIProviderRequest["agentContext"],
    previousIntent: null,
    memoryContext: {} as AIProviderRequest["memoryContext"],
    address: "0xabc",
  };
}

describe("classifyAgentTask", () => {
  it("classifies structured prepare prompts", () => {
    expect(classifyAgentTask("Prepare a token swap on Base")).toBe("structured");
    expect(classifyAgentTask("Prepare an x402 payment")).toBe("structured");
  });

  it("classifies research prompts", () => {
    expect(classifyAgentTask("What is MPGR?")).toBe("research");
    expect(classifyAgentTask("Research Base markets")).toBe("research");
  });
});

describe("resolveProviderKindOrder", () => {
  it("always ends with deterministic and only uses implemented network kinds", () => {
    const order = resolveProviderKindOrder("general");
    expect(order.at(-1)).toBe("deterministic");
    expect(order).toContain("gemini");
    expect(order).toContain("openai");
    expect(order).not.toContain("anthropic");
  });

  it("prefers gemini for research when implemented", () => {
    expect(resolveProviderKindOrder("research")[0]).toBe("gemini");
  });
});

describe("ProviderChainAIProvider", () => {
  it("falls through to the next provider after a rate-limit style failure", async () => {
    const failing: AIProvider = {
      name: "gemini",
      requiresNetwork: true,
      generateReply: vi.fn().mockRejectedValue(new Error("429 RESOURCE_EXHAUSTED")),
    };
    const ok: AIProvider = {
      name: "openai",
      requiresNetwork: true,
      generateReply: vi.fn().mockResolvedValue({
        intent: "general_help",
        reply: "ok",
        actions: [],
        highlights: [],
        followUps: [],
      } satisfies AIProviderResponse),
    };
    const chain = new ProviderChainAIProvider([failing, ok], fakeBus(), fakeLogger());
    const result = await chain.generateReply(request("What is MPGR?"));
    expect(result.reply).toBe("ok");
    expect(ok.generateReply).toHaveBeenCalledOnce();
  });
});

describe("TimeoutAIProvider", () => {
  it("rejects when the inner provider exceeds the timeout", async () => {
    const slow: AIProvider = {
      name: "gemini",
      requiresNetwork: true,
      generateReply: () => new Promise(() => undefined),
    };
    const timed = new TimeoutAIProvider(slow, 20);
    await expect(timed.generateReply(request("hello"))).rejects.toBeInstanceOf(AIProviderTimeoutError);
  });
});

describe("isRateLimitMessage", () => {
  it("detects quota and 429 text", () => {
    expect(isRateLimitMessage("429 Too Many Requests")).toBe(true);
    expect(isRateLimitMessage("RESOURCE_EXHAUSTED quota")).toBe(true);
    expect(isRateLimitMessage("network down")).toBe(false);
  });
});
