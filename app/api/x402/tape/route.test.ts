// app/api/x402/tape/route.test.ts
//
// Route-level contract for the paid tape:
//   no pay  → 402 with a standard x402 payment-required body
//   bad pay → 402 fail closed (no tape)
//   good pay (mocked facilitator pipeline) → 200, body has stocks[]
// The cryptographic checks themselves are covered in
// lib/x402/__tests__/x402-tape-resource.test.ts with real signatures.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAY_TO = "0xE8e26183C0F8C44D8A46B9D2b78b0F2A0f7e5a6d";

const getTapeSnapshot = vi.fn();
vi.mock("@/lib/markets/tape", () => ({
  getTapeSnapshot,
  tapeCacheTtlSeconds: () => 10,
}));

vi.mock("@/lib/trade/trade-rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 })),
  clientIpFromRequest: () => "203.0.113.9",
}));

const processTapeXPayment = vi.fn();
vi.mock("@/lib/x402/x402-tape-resource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/x402/x402-tape-resource")>();
  return {
    ...actual,
    x402TapePayTo: () => (process.env.X402_TAPE_PAY_TO ? (PAY_TO as `0x${string}`) : null),
    processTapeXPayment,
  };
});

const SNAPSHOT = {
  asOf: "2026-09-21T12:00:00.000Z",
  chainId: 8453,
  blockNumber: 30_000_000,
  wrapped: [
    { symbol: "cbBTC", name: "Coinbase Wrapped BTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", usd: 86648.61, change24h: 6.61, source: "DexScreener (Base)", stale: false, updatedAt: 1790000000 },
  ],
  stocks: [
    { symbol: "NVDAc", name: "NVIDIA Tokenized Stock (Coinbase)", address: "0xb20000000000000000000078ee7ce2fE4908108C", usdFeed: 182.4, usdDex: 183.1, premiumBps: 38, change24h: 0.9, source: "Chainlink + DexScreener", stale: false, paused: false, feedUpdatedAt: 1790000000, dexUpdatedAt: 1790000000, feedStale: false },
  ],
};

function tapeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://mpgrhub.xyz/api/x402/tape", { method: "GET", headers });
}

describe("GET /api/x402/tape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTapeSnapshot.mockResolvedValue(SNAPSHOT);
    process.env.X402_TAPE_PAY_TO = PAY_TO;
  });

  afterEach(() => {
    delete process.env.X402_TAPE_PAY_TO;
  });

  it("unpaid request → 402 with x402 payment requirements for USDC on Base", async () => {
    const { GET } = await import("./route");
    const response = await GET(tapeRequest());

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    const accept = body.accepts[0];
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("eip155:8453");
    expect(accept.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(accept.maxAmountRequired).toBe("20000"); // 0.02 USDC
    expect(accept.description).toBe("MPGR / Base Stocks live tape snapshot");
    expect(accept.resource).toBe("https://mpgrhub.xyz/api/x402/tape");
    expect(response.headers.get("X-PAYMENT-REQUIRED")).toBeTruthy();
    // The tape itself is never served unpaid.
    expect(getTapeSnapshot).not.toHaveBeenCalled();
  });

  it("bad payment → 402 fail closed with the rejection reason", async () => {
    processTapeXPayment.mockResolvedValue({
      ok: false,
      code: "INVALID_PAYMENT",
      message: "The payment amount is below the required price.",
    });
    const { GET } = await import("./route");
    const response = await GET(tapeRequest({ "x-payment": "ZmFrZS1wYXltZW50" }));

    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.error).toContain("below the required price");
    expect(body.accepts).toHaveLength(1);
    expect(getTapeSnapshot).not.toHaveBeenCalled();
  });

  it("facilitator outage → 503, no free tape", async () => {
    processTapeXPayment.mockResolvedValue({
      ok: false,
      code: "FACILITATOR_UNAVAILABLE",
      message: "The payment facilitator is unavailable. No payment was taken; retry shortly.",
    });
    const { GET } = await import("./route");
    const response = await GET(tapeRequest({ "x-payment": "ZmFrZS1wYXltZW50" }));

    expect(response.status).toBe(503);
    expect(getTapeSnapshot).not.toHaveBeenCalled();
  });

  it("good payment (mocked pipeline) → 200 with stocks[] + paid:true + settlement header", async () => {
    processTapeXPayment.mockResolvedValue({
      ok: true,
      payer: "0xd57b0000000000000000000000000000000095f7",
      settlement: { success: true, transaction: "0xfeed", network: "eip155:8453" },
      paymentResponseHeader: Buffer.from(
        JSON.stringify({ success: true, transaction: "0xfeed" }),
        "utf-8",
      ).toString("base64"),
    });
    const { GET } = await import("./route");
    const response = await GET(tapeRequest({ "x-payment": "c2lnbmVkLXBheW1lbnQ=" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.paid).toBe(true);
    expect(body.paymentTx).toBe("0xfeed");
    expect(Array.isArray(body.stocks)).toBe(true);
    expect(body.stocks[0].symbol).toBe("NVDAc");
    expect(Array.isArray(body.wrapped)).toBe(true);
    const settlementHeader = response.headers.get("X-PAYMENT-RESPONSE");
    expect(settlementHeader).toBeTruthy();
    expect(JSON.parse(Buffer.from(settlementHeader!, "base64").toString("utf-8"))).toEqual({
      success: true,
      transaction: "0xfeed",
    });
  });

  it("accepts the PAYMENT-SIGNATURE header alias", async () => {
    processTapeXPayment.mockResolvedValue({
      ok: false,
      code: "INVALID_PAYMENT",
      message: "The payment header is not a valid x402 exact-scheme payload.",
    });
    const { GET } = await import("./route");
    const response = await GET(tapeRequest({ "payment-signature": "c2lnbmVk" }));
    expect(response.status).toBe(402);
    expect(processTapeXPayment).toHaveBeenCalledTimes(1);
  });

  it("missing X402_TAPE_PAY_TO → 503 fail closed (never free, never payable-to-nowhere)", async () => {
    delete process.env.X402_TAPE_PAY_TO;
    const { GET } = await import("./route");
    const response = await GET(tapeRequest());

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("X402_TAPE_UNCONFIGURED");
    expect(getTapeSnapshot).not.toHaveBeenCalled();
  });
});
