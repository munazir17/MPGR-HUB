import { afterEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/architecture/agentkit", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/architecture/agentkit")
  >("@/lib/architecture/agentkit");

  return {
    ...actual,
    invokeAgentKitAction: (...args: unknown[]) => mockInvoke(...args),
    isAgentKitErrorPayload: (value: unknown) =>
      Boolean(
        value &&
          typeof value === "object" &&
          (value as { error?: unknown }).error === true,
      ),
    mapAgentKitHttpResult: (parsed: unknown, url: string) => ({
      status: 402,
      body: parsed,
      contentType: "application/json",
      finalUrl: url,
    }),
  };
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/agentkit/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agentkit/invoke", () => {
  afterEach(() => {
    mockInvoke.mockReset();
  });

  it("returns 403 for native_transfer and never forwards CDP secrets", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      code: "ACTION_DENIED",
      error:
        "AgentKit is configured prepare-only on Base. Signing, payment, and transaction submission stay behind the MPGR Confirm UX and the user's connected wallet.",
    });

    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({
        actionName: "native_transfer",
        args: { to: "0x1111111111111111111111111111111111111111", value: "1" },
        cdpApiKeyId: "must-not-be-used",
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ACTION_DENIED");
    expect(JSON.stringify(body)).not.toContain("must-not-be-used");
    expect(JSON.stringify(body)).not.toMatch(/CDP_/i);
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ actionName: "native_transfer" }),
    );
    expect(mockInvoke.mock.calls[0][0]).not.toHaveProperty("cdpApiKeyId");
  });

  it("returns 403 for make_http_request_with_x402", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      code: "ACTION_DENIED",
      error: "denied",
    });

    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({
        actionName: "make_http_request_with_x402",
        args: { url: "https://example.com" },
      }),
    );

    expect(res.status).toBe(403);
  });

  it("rejects a private-IP make_http_request before AgentKit fetch", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({
        actionName: "make_http_request",
        args: { url: "https://127.0.0.1/secret" },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe("INVALID_URL");
  });

  it("rejects a prefixed AgentKit make_http_request to a private host", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({
        actionName: "X402ActionProvider_make_http_request",
        args: { url: "https://192.168.0.9/secret" },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("rejects http:// make_http_request URLs", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({
        actionName: "make_http_request",
        args: { url: "http://example.com/paid" },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
