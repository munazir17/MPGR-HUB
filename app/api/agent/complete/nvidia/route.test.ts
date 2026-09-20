// app/api/agent/complete/nvidia/route.test.ts
//
// CSRF coverage plus NVIDIA-specific skip/upstream behaviour.
// verifyTrustedOrigin runs for real. Session and rate-limit are mocked
// so tests never need Redis or a real NVIDIA_API_KEY.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const getSessionFromRequest = vi.fn<() => { wallet: string } | null>();
vi.mock("@/lib/auth/session", () => ({
  getSessionFromRequest,
}));
// Task 6: routes authenticate via the server-side session registry; the
// test keeps driving the same fake through the async entry point.
vi.mock("@/lib/auth/session-store", () => ({
  authenticateRequest: async () => getSessionFromRequest(),
}));


vi.mock("@/lib/api/request-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/request-guard")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue(null),
    enforceAiDailyBudget: vi.fn().mockResolvedValue(null),
    recordAiTokenUsage: vi.fn().mockResolvedValue(undefined),
  };
});

const APP_ORIGIN = "https://mpgrhub.xyz";
const FAKE_KEY = "test-nvidia-key-not-for-production";

function postComplete(
  headers: Record<string, string> = {},
  body: Record<string, unknown> = { systemPrompt: "s", userPrompt: "u" },
) {
  return new Request(`${APP_ORIGIN}/api/agent/complete/nvidia`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/complete/nvidia — CSRF (real verifyTrustedOrigin)", () => {
  let savedAppOrigin: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedAppOrigin = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = APP_ORIGIN;
    getSessionFromRequest.mockReturnValue(null);
  });

  afterEach(() => {
    if (savedAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedAppOrigin;
  });

  it("lets a trusted-origin request reach the route's own logic (past the origin gate)", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: APP_ORIGIN }));
    expect(getSessionFromRequest).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
  });

  it("rejects a cross-origin request with 403 before the protected operation runs", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: "https://evil.com" }));
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin/Referer at all", async () => {
    const { POST } = await import("./route");
    const response = await POST(postComplete());
    expect(response.status).toBe(403);
    expect(getSessionFromRequest).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent/complete/nvidia — key skip and upstream", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubEnv("APP_ORIGIN", APP_ORIGIN);
    getSessionFromRequest.mockReturnValue({
      wallet: "0xd57b0000000000000000000000000000000095f7",
    });
  });

  it("skips gracefully with 503 when NVIDIA_API_KEY is missing", async () => {
    vi.stubEnv("NVIDIA_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: APP_ORIGIN }));
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.error).toMatch(/NVIDIA_API_KEY is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toMatch(/Bearer /);
  });

  it("posts to the official NIM chat completions URL with a Bearer token", async () => {
    vi.stubEnv("NVIDIA_API_KEY", FAKE_KEY);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ intent: "general_help", reply: "hello from nim" }),
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: APP_ORIGIN }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.content).toContain("hello from nim");
    expect(JSON.stringify(payload)).not.toContain(FAKE_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    const upstreamBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(JSON.stringify(upstreamBody)).not.toContain(FAKE_KEY);
    expect(upstreamBody.model).toBe("nvidia/nemotron-3-super-120b-a12b");
  });

  it("converts a native NVIDIA tool_call into the MPGR toolCall protocol", async () => {
    vi.stubEnv("NVIDIA_API_KEY", FAKE_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "tokenized_stock_prepare_order",
                      arguments: JSON.stringify({ symbol: "AAPLc", amount: "50", side: "BUY" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      }),
    );

    const { POST } = await import("./route");
    const response = await POST(postComplete({ origin: APP_ORIGIN }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { content: string };
    expect(JSON.parse(payload.content)).toEqual({
      toolCall: {
        toolId: "tokenized_stock_prepare_order",
        arguments: { symbol: "AAPLc", amount: "50", side: "BUY" },
      },
    });
  });
});
