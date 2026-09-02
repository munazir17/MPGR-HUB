import { afterEach, describe, expect, it, vi } from "vitest";

import { X402_SUPPORTED_NETWORK } from "@/lib/x402/x402-config";

const { mockInvoke, mockDiscover } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDiscover: vi.fn(),
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

vi.mock("@/lib/x402/x402-discover", async () => {
  const actual = await vi.importActual<typeof import("@/lib/x402/x402-discover")>(
    "@/lib/x402/x402-discover",
  );
  return {
    ...actual,
    discoverX402Resource: (...args: unknown[]) => mockDiscover(...args),
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
    mockDiscover.mockReset();
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
    expect(mockDiscover).not.toHaveBeenCalled();

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
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("falls back to a native GET when AgentKit reports a provider error, and still surfaces the real 402", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      code: "PROVIDER_ERROR",
      error: "AgentKit provider failed",
    });
    mockDiscover.mockResolvedValue({
      status: 402,
      body: {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base-sepolia",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            maxAmountRequired: "1000",
            payTo: "0x021028695EAfDDe60E139D87000a8bd6cB65645e",
            resource: "https://x402-demo-discovery-endpoint.vercel.app/protected/testnet",
            maxTimeoutSeconds: 300,
          },
        ],
      },
      contentType: "application/json",
      finalUrl:
        "https://x402-demo-discovery-endpoint.vercel.app/protected/testnet",
    });

    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({
        resourceUrl:
          "https://x402-demo-discovery-endpoint.vercel.app/protected/testnet",
      }),
    );

    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe(402);
    // Base Sepolia is reported as-is by the fallback path (native fetch
    // does not run mainnet normalization) — the app's payment/parse
    // layer, not discovery, is what enforces mainnet-only.
    expect(body.body.accepts[0].network).toBe("base-sepolia");
    expect(body.body.accepts[0].maxAmountRequired).toBe("1000");
  });

  it("does not fall back on ACTION_DENIED — a policy block is returned directly", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      code: "ACTION_DENIED",
      error: "make_http_request_with_x402 is denied",
    });

    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({ resourceUrl: "https://api.example.com/paid" }),
    );

    expect(mockDiscover).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });

  it("falls back when AgentKit's result is an unrecognized shape instead of reporting unreachable", async () => {
    mockInvoke.mockResolvedValue({
      ok: true,
      actionName: "make_http_request",
      result: { weird: "shape", nothing: "recognized" },
    });
    mockDiscover.mockResolvedValue({
      status: 500,
      body: null,
      contentType: "text/plain",
      finalUrl: "https://api.example.com/paid",
    });

    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({ resourceUrl: "https://api.example.com/paid" }),
    );

    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    // A real HTTP 500 must be preserved as 500 — never silently
    // collapsed into "unreachable" or a fabricated success.
    expect(body.status).toBe(500);
    expect(body.body).toBeNull();
  });

  it("preserves a genuine connectivity failure from the fallback as a distinct error, not a 402 or 500", async () => {
    mockInvoke.mockResolvedValue({
      ok: false,
      code: "PROVIDER_ERROR",
      error: "AgentKit provider failed",
    });
    const { X402DiscoveryError } = await import("@/lib/x402/x402-discover");
    mockDiscover.mockRejectedValue(
      new X402DiscoveryError("DNS lookup failed", "FETCH_FAILED"),
    );

    const { POST } = await import("./route");
    const res = await POST(
      jsonRequest({ resourceUrl: "https://api.example.com/paid" }),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("FETCH_FAILED");
  });

  it("never invokes payment execution during discovery, on either path", async () => {
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
          },
        ],
      },
    });

    const { POST } = await import("./route");
    await POST(jsonRequest({ resourceUrl: "https://api.example.com/paid" }));

    for (const call of mockInvoke.mock.calls) {
      expect(call[0]?.actionName).not.toBe("make_http_request_with_x402");
    }
  });
});
