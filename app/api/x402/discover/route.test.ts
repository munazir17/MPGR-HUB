import { afterEach, describe, expect, it, vi } from "vitest";

import { X402_SUPPORTED_NETWORK } from "@/lib/x402/x402-config";

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
  };
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/x402/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/x402/discover via AgentKit", () => {
  afterEach(() => {
    mockInvoke.mockReset();
  });

  it("discovers through AgentKit make_http_request after the SSRF gate", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      actionName: "make_http_request",
      result: {
        status: "error_402_payment_required",
        acceptablePaymentOptions: [
          {
            scheme: "exact",
            network: "base",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            maxAmountRequired: "1000000",
            payTo: "0x1111111111111111111111111111111111111111",
            resource: "https://api.example.com/paid",
            extra: { name: "USDC", version: "2" },
          },
        ],
      },
    });

    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({ resourceUrl: "https://api.example.com/paid" }),
    );

    expect(res.status).toBe(200);
    expect(mockInvoke).toHaveBeenCalledWith({
      actionName: "make_http_request",
      args: { url: "https://api.example.com/paid", method: "GET" },
    });

    const body = await res.json();
    expect(body.status).toBe(402);
    expect(body.body.accepts[0].network).toBe(X402_SUPPORTED_NETWORK);
    expect(body.body.accepts[0].maxAmountRequired).toBe("1000000");
    expect(JSON.stringify(body)).not.toMatch(/CDP_/i);
  });

  it("rejects localhost before AgentKit is invoked", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({ resourceUrl: "https://localhost/paid" }),
    );
    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
