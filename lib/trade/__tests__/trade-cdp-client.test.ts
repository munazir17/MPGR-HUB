import { afterEach, describe, expect, it, vi } from "vitest";

const { mockJwt } = vi.hoisted(() => ({ mockJwt: vi.fn(() => "header.payload.sig") }));

vi.mock("../trade-jwt", () => ({
  generateCdpJwt: (...args: unknown[]) => mockJwt(...args),
}));

const { getCdpSwapPrice, createCdpSwapQuote, hasTradeApiCredentials } = await import(
  "../trade-cdp-client"
);

describe("trade-cdp-client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockJwt.mockClear();
  });

  it("returns CREDENTIALS_MISSING when CDP keys are absent", async () => {
    vi.stubEnv("CDP_API_KEY_ID", "");
    vi.stubEnv("CDP_API_KEY_SECRET", "");
    expect(hasTradeApiCredentials()).toBe(false);
    const result = await getCdpSwapPrice({
      fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      toToken: "0x4200000000000000000000000000000000000006",
      fromAmount: "1000000",
      taker: "0x2222222222222222222222222222222222222222",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CREDENTIALS_MISSING");
  });

  it("GET price uses the documented /platform/v2/evm/swaps path", async () => {
    vi.stubEnv("CDP_API_KEY_ID", "key-id");
    vi.stubEnv("CDP_API_KEY_SECRET", "key-secret");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          liquidityAvailable: true,
          fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          toToken: "0x4200000000000000000000000000000000000006",
          fromAmount: "1000000",
          toAmount: "400000000000000",
          minToAmount: "396000000000000",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getCdpSwapPrice({
      fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      toToken: "0x4200000000000000000000000000000000000006",
      fromAmount: "1000000",
      taker: "0x2222222222222222222222222222222222222222",
      slippageBps: 100,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.cdp.coinbase.com/platform/v2/evm/swaps?");
    expect(url).toContain("network=base");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer header.payload.sig");
    expect(mockJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        requestMethod: "GET",
        requestHost: "api.cdp.coinbase.com",
        requestPath: "/platform/v2/evm/swaps",
      }),
    );
  });

  it("POST quote returns transaction + permit2 when CDP does", async () => {
    vi.stubEnv("CDP_API_KEY_ID", "key-id");
    vi.stubEnv("CDP_API_KEY_SECRET", "key-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            liquidityAvailable: true,
            fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            toToken: "0x4200000000000000000000000000000000000006",
            fromAmount: "1000000",
            toAmount: "400000000000000",
            minToAmount: "396000000000000",
            transaction: {
              to: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
              data: "0xdead",
              value: "0",
              gas: "210000",
            },
            permit2: {
              eip712: {
                domain: { name: "Permit2", chainId: 8453 },
                types: { PermitTransferFrom: [{ name: "spender", type: "address" }] },
                primaryType: "PermitTransferFrom",
                message: { spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
              },
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await createCdpSwapQuote({
      fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      toToken: "0x4200000000000000000000000000000000000006",
      fromAmount: "1000000",
      taker: "0x2222222222222222222222222222222222222222",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transaction?.data).toBe("0xdead");
    expect(result.value.permit2?.eip712.primaryType).toBe("PermitTransferFrom");
  });
});
