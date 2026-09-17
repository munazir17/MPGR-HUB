import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnyAgentTool } from "@/lib/architecture/tools/agent-tool";
import {
  DEFAULT_NVIDIA_BASE_URL,
  DEFAULT_NVIDIA_MODEL,
  classifyNvidiaUpstreamFailure,
  extractNvidiaResponseContent,
  nvidiaChatCompletionsUrl,
  resolveNvidiaBaseUrl,
  resolveNvidiaModel,
  toNvidiaTools,
} from "../nvidia-function-calling";

function fakeTool(overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
  return {
    id: "tokenized_stock_prepare_order",
    name: "Tokenized Stock Swap Preview",
    description:
      "Prepares an on-chain Base swap proposal. Never signs. Never broadcast a transaction.",
    category: "market",
    mode: "prepare",
    riskLevel: "medium",
    requiresWallet: true,
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "B20 ticker" },
        amount: { type: "string" },
      },
      required: ["symbol", "amount"],
    },
    execute: async () => {
      throw new Error("tools are not executed in this unit test");
    },
    ...overrides,
  };
}

describe("NVIDIA NIM config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the official hosted NIM base URL and Nemotron Super model", () => {
    vi.stubEnv("NVIDIA_BASE_URL", "");
    vi.stubEnv("NVIDIA_MODEL", "");
    expect(resolveNvidiaBaseUrl()).toBe(DEFAULT_NVIDIA_BASE_URL);
    expect(resolveNvidiaModel()).toBe(DEFAULT_NVIDIA_MODEL);
    expect(DEFAULT_NVIDIA_MODEL).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(nvidiaChatCompletionsUrl()).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions",
    );
  });

  it("honours a custom https base URL without a trailing slash", () => {
    expect(resolveNvidiaBaseUrl("https://example.nvidia.test/v1/")).toBe(
      "https://example.nvidia.test/v1",
    );
  });

  it("rejects non-http(s) base URLs", () => {
    expect(() => resolveNvidiaBaseUrl("javascript:alert(1)")).toThrow(/http or https/);
  });
});

describe("toNvidiaTools", () => {
  it("lowers only read/prepare tools into OpenAI-compatible function tools", () => {
    const tools = toNvidiaTools([
      fakeTool(),
      fakeTool({ id: "wallet_execute_swap", mode: "execute", description: "Would sign." }),
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function.name).toBe("tokenized_stock_prepare_order");
    expect(tools[0]?.function.description).toMatch(/Never signs/);
    expect(tools[0]?.function.parameters.type).toBe("object");
    expect(tools[0]?.function.parameters.required).toEqual(["symbol", "amount"]);
  });
});

describe("extractNvidiaResponseContent", () => {
  it("parses a normal text JSON reply", () => {
    const content = extractNvidiaResponseContent({
      choices: [
        {
          message: {
            content: JSON.stringify({ intent: "general_help", reply: "All good." }),
          },
        },
      ],
    });
    expect(content).toBe(JSON.stringify({ intent: "general_help", reply: "All good." }));
  });

  it("converts a native tool_call into the MPGR toolCall format", () => {
    const content = extractNvidiaResponseContent({
      choices: [
        {
          message: {
            content: "thinking...",
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "trade_get_price",
                  arguments: '{"fromToken":"ETH","toToken":"USDC"}',
                },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.parse(content ?? "")).toEqual({
      toolCall: {
        toolId: "trade_get_price",
        arguments: { fromToken: "ETH", toToken: "USDC" },
      },
    });
  });

  it("uses only the first tool call when several are returned", () => {
    const content = extractNvidiaResponseContent({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: { name: "tokenized_stock_research", arguments: { symbol: "AAPL" } },
              },
              {
                function: { name: "trade_prepare_swap", arguments: { fromToken: "USDC" } },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.parse(content ?? "").toolCall.toolId).toBe("tokenized_stock_research");
  });

  it("rewrites x402 url aliases to resourceUrl", () => {
    const content = extractNvidiaResponseContent({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "x402_discover_resource",
                  arguments: '{"url":"https://api.example.com/paid"}',
                },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.parse(content ?? "")).toEqual({
      toolCall: {
        toolId: "x402_discover_resource",
        arguments: { resourceUrl: "https://api.example.com/paid" },
      },
    });
  });
});

describe("classifyNvidiaUpstreamFailure", () => {
  it("classifies 429 vs auth vs generic failures", () => {
    expect(classifyNvidiaUpstreamFailure(429).code).toBe("PROVIDER_RATE_LIMITED");
    expect(classifyNvidiaUpstreamFailure(401).code).toBe("PROVIDER_AUTH_ERROR");
    expect(classifyNvidiaUpstreamFailure(500).code).toBe("PROVIDER_ERROR");
  });
});
