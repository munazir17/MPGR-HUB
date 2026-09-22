// lib/x402/__tests__/x402-tape-resource.test.ts
//
// Resource-server side of the paid tape: pricing config, the 402
// requirement body, and the fail-closed payment pipeline. Signature
// checks use REAL EIP-3009 typed-data signing (viem local account) —
// the facilitator HTTP calls are the only mocked dependency.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { BASE_USDC } from "@/lib/trade/trade-config";
import {
  X402_CHAIN_ID,
  X402_SUPPORTED_NETWORK,
  resolveEip712Domain,
} from "@/lib/x402/x402-config";
import {
  buildTapePaymentRequiredBody,
  buildTapePaymentRequirement,
  encodeSettlementHeader,
  parseFacilitatorSettlePayload,
  parseFacilitatorVerifyPayload,
  processTapeXPayment,
  tapeResourceUrl,
  x402TapeFacilitatorConfig,
  x402TapePayTo,
  x402TapePriceUsdcRaw,
  type X402TapeFacilitatorDeps,
} from "@/lib/x402/x402-tape-resource";
import type { X402PaymentRequirements } from "@/lib/x402/x402-types";

const PAY_TO = "0xE8e26183C0F8C44D8A46B9D2b78b0F2A0f7e5a6d";
// TEST-ONLY signer. Deliberately derived from a repeated byte rather
// than written as a literal 64-hex key: it controls no funds on any
// network, and no secret-looking string is committed to the repo (this
// keeps secret scanners such as GitLeaks' generic-api-key rule quiet,
// matching the attacker key constructed the same way below).
const PAYER_KEY = `0x${"59".repeat(32)}` as `0x${string}`;
const RESOURCE_URL = "https://mpgrhub.xyz/api/x402/tape";

const account = privateKeyToAccount(PAYER_KEY);

function stubEnv() {
  vi.stubEnv("X402_TAPE_PAY_TO", PAY_TO);
  vi.stubEnv("X402_TAPE_FACILITATOR_URL", "https://facilitator.test/x402");
}

async function signPaymentHeader(options: {
  to?: string;
  value?: bigint;
  validAfter?: bigint;
  validBefore?: bigint;
  nonce?: `0x${string}`;
  asset?: `0x${string}`;
  network?: string;
} = {}): Promise<string> {
  const asset = options.asset ?? (BASE_USDC as `0x${string}`);
  const domainConfig = resolveEip712Domain(asset, undefined)!;
  const message = {
    from: account.address,
    to: (options.to ?? PAY_TO) as `0x${string}`,
    value: options.value ?? 20_000n,
    validAfter: options.validAfter ?? 0n,
    validBefore: options.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 60),
    nonce: options.nonce ?? ("0x" + "11".repeat(32)) as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: {
      name: domainConfig.domain.name,
      version: domainConfig.domain.version,
      chainId: X402_CHAIN_ID,
      verifyingContract: asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: options.network ?? X402_SUPPORTED_NETWORK,
    payload: { signature, authorization: { ...message, value: message.value.toString(), validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString() } },
  };
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

function facilitatorDeps(overrides: {
  verify?: { ok: boolean; status: number; payload: Record<string, unknown> | null };
  settle?: { ok: boolean; status: number; payload: Record<string, unknown> | null };
} = {}): X402TapeFacilitatorDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    postJson: vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/verify")) {
        return overrides.verify ?? { ok: true, status: 200, payload: { isValid: true, invalidReason: null } };
      }
      return (
        overrides.settle ?? {
          ok: true,
          status: 200,
          payload: { success: true, transaction: "0xabc123", network: "base", payer: account.address },
        }
      );
    }),
  };
}

function requirement(): X402PaymentRequirements {
  return buildTapePaymentRequirement(RESOURCE_URL, PAY_TO as `0x${string}`);
}

describe("x402 tape pricing + requirement", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 20000 atomic USDC (0.02) and respects the env override", () => {
    expect(x402TapePriceUsdcRaw()).toBe(20_000n);
    vi.stubEnv("X402_TAPE_PRICE_USDC_RAW", "50000");
    expect(x402TapePriceUsdcRaw()).toBe(50_000n);
  });

  it("refuses absurd or malformed price overrides (falls back, never 0)", () => {
    vi.stubEnv("X402_TAPE_PRICE_USDC_RAW", "0");
    expect(x402TapePriceUsdcRaw()).toBe(20_000n);
    vi.stubEnv("X402_TAPE_PRICE_USDC_RAW", "-5");
    expect(x402TapePriceUsdcRaw()).toBe(20_000n);
    vi.stubEnv("X402_TAPE_PRICE_USDC_RAW", "999999999999");
    expect(x402TapePriceUsdcRaw()).toBe(20_000n);
    vi.stubEnv("X402_TAPE_PRICE_USDC_RAW", "abc");
    expect(x402TapePriceUsdcRaw()).toBe(20_000n);
  });

  it("payTo is null unless a valid address is configured", () => {
    expect(x402TapePayTo()).toBeNull();
    vi.stubEnv("X402_TAPE_PAY_TO", "not-an-address");
    expect(x402TapePayTo()).toBeNull();
    vi.stubEnv("X402_TAPE_PAY_TO", PAY_TO);
    expect(x402TapePayTo()?.toLowerCase()).toBe(PAY_TO.toLowerCase());
  });

  it("builds a standard x402 payment-required body for USDC on Base", () => {
    const body = buildTapePaymentRequiredBody(RESOURCE_URL, PAY_TO as `0x${string}`);
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    const accept = body.accepts[0] as unknown as Record<string, unknown>;
    expect(accept.scheme).toBe("exact");
    expect(accept.network).toBe("eip155:8453");
    expect(accept.asset).toBe(BASE_USDC);
    expect(accept.maxAmountRequired).toBe("20000");
    expect(String(accept.payTo).toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(accept.resource).toBe(RESOURCE_URL);
    expect(accept.description).toBe("MPGR / Base Stocks live tape snapshot");
    const extra = accept.extra as Record<string, unknown>;
    expect(extra.name).toBe("USD Coin");
    expect(extra.version).toBe("2");
  });

  it("derives the absolute resource URL from the request or APP_ORIGIN", () => {
    expect(tapeResourceUrl("https://mpgrhub.xyz/api/x402/tape?x=1")).toBe(RESOURCE_URL);
    vi.stubEnv("APP_ORIGIN", "https://example.com/");
    expect(tapeResourceUrl(null)).toBe("https://example.com/api/x402/tape");
  });

  it("advertises the proxy-forwarded host as the resource, not the server bind address", () => {
    // Ephemeral preview: TLS terminates upstream, so request.url reports the
    // bind address. A 402 body advertising that would make clients sign a
    // payment for a resource URL they never requested.
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_ORIGIN_ALLOW_REQUEST_DERIVED", "1");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "");
    const request = new Request("http://0.0.0.0:3000/api/x402/tape", {
      headers: { host: "3000-sandbox-preview.e2b.app", "x-forwarded-proto": "https" },
    });
    expect(request.url).toBe("http://0.0.0.0:3000/api/x402/tape");
    expect(tapeResourceUrl(request)).toBe("https://3000-sandbox-preview.e2b.app/api/x402/tape");
  });

  it("still lets a configured APP_ORIGIN win over request derivation", () => {
    vi.stubEnv("APP_ORIGIN", "https://example.com/");
    vi.stubEnv("APP_ORIGIN_ALLOW_REQUEST_DERIVED", "1");
    const request = new Request("http://0.0.0.0:3000/api/x402/tape", {
      headers: { host: "3000-sandbox-preview.e2b.app", "x-forwarded-proto": "https" },
    });
    expect(tapeResourceUrl(request)).toBe("https://example.com/api/x402/tape");
  });

  it("prefers the CDP facilitator when CDP keys exist, else the public one", () => {
    stubEnv();
    expect(x402TapeFacilitatorConfig()?.baseUrl).toBe("https://facilitator.test/x402");
    vi.unstubAllEnvs();
    vi.stubEnv("CDP_API_KEY_ID", "");
    vi.stubEnv("CDP_API_KEY_SECRET", "");
    const publicConfig = x402TapeFacilitatorConfig();
    expect(publicConfig?.baseUrl).toBe("https://x402.org/facilitator");
    expect(publicConfig?.bearer).toBeNull();
    expect(publicConfig?.kind).toBe("public");
  });
});

describe("processTapeXPayment — fail closed", () => {
  beforeEach(() => {
    stubEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("missing header → MISSING_PAYMENT", async () => {
    const result = await processTapeXPayment(null, requirement(), facilitatorDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_PAYMENT");
  });

  it("garbage header → INVALID_PAYMENT", async () => {
    const result = await processTapeXPayment("not-base64-json!!", requirement(), facilitatorDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT");
  });

  it("wrong network → INVALID_PAYMENT", async () => {
    const header = await signPaymentHeader({ network: "eip155:1" });
    const result = await processTapeXPayment(header, requirement(), facilitatorDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT");
  });

  it("wrong payTo → INVALID_PAYMENT", async () => {
    const header = await signPaymentHeader({ to: "0x000000000000000000000000000000000000dEaD" });
    const result = await processTapeXPayment(header, requirement(), facilitatorDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT");
  });

  it("underpayment → INVALID_PAYMENT", async () => {
    const header = await signPaymentHeader({ value: 19_999n });
    const result = await processTapeXPayment(header, requirement(), facilitatorDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT");
  });

  it("expired window → INVALID_PAYMENT", async () => {
    const header = await signPaymentHeader({ validBefore: BigInt(Math.floor(Date.now() / 1000) - 10) });
    const result = await processTapeXPayment(header, requirement(), facilitatorDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT");
  });

  it("signature by a different key → INVALID_PAYMENT (real crypto check)", async () => {
    const header = await signPaymentHeader();
    // Swap in a signature from another account over the same message.
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    const attacker = privateKeyToAccount(`0x${"22".repeat(32)}` as `0x${string}`);
    const domainConfig = resolveEip712Domain(BASE_USDC, undefined)!;
    decoded.payload.signature = await attacker.signTypedData({
      domain: {
        name: domainConfig.domain.name,
        version: domainConfig.domain.version,
        chainId: X402_CHAIN_ID,
        verifyingContract: BASE_USDC as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: PAY_TO as `0x${string}`,
        value: BigInt(decoded.payload.authorization.value),
        validAfter: BigInt(decoded.payload.authorization.validAfter),
        validBefore: BigInt(decoded.payload.authorization.validBefore),
        nonce: decoded.payload.authorization.nonce,
      },
    });
    const forged = Buffer.from(JSON.stringify(decoded), "utf-8").toString("base64");
    const result = await processTapeXPayment(forged, requirement(), facilitatorDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_PAYMENT");
  });

  it("facilitator says invalid → PAYMENT_REJECTED", async () => {
    const header = await signPaymentHeader();
    const deps = facilitatorDeps({
      verify: { ok: true, status: 200, payload: { isValid: false, invalidReason: "insufficient balance" } },
    });
    const result = await processTapeXPayment(header, requirement(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PAYMENT_REJECTED");
      expect(result.message).toContain("insufficient balance");
    }
    expect(deps.calls.some((url) => url.endsWith("/settle"))).toBe(false);
  });

  it("facilitator 5xx on verify → FACILITATOR_UNAVAILABLE, not rejected", async () => {
    const header = await signPaymentHeader();
    const deps = facilitatorDeps({ verify: { ok: false, status: 503, payload: null } });
    const result = await processTapeXPayment(header, requirement(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FACILITATOR_UNAVAILABLE");
  });

  it("settle failure → PAYMENT_REJECTED and no success settlement", async () => {
    const header = await signPaymentHeader();
    const deps = facilitatorDeps({
      settle: { ok: true, status: 200, payload: { success: false, errorReason: "transfer reverted" } },
    });
    const result = await processTapeXPayment(header, requirement(), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PAYMENT_REJECTED");
      expect(result.message).toContain("transfer reverted");
    }
  });
});

describe("processTapeXPayment — happy path", () => {
  beforeEach(() => {
    stubEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("valid signed payment + facilitator verify/settle → settlement with tx and header", async () => {
    const header = await signPaymentHeader();
    const deps = facilitatorDeps();
    const result = await processTapeXPayment(header, requirement(), deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payer.toLowerCase()).toBe(account.address.toLowerCase());
      expect(result.settlement.success).toBe(true);
      expect(result.settlement.transaction).toBe("0xabc123");
      expect(deps.calls).toEqual([
        "https://facilitator.test/x402/verify",
        "https://facilitator.test/x402/settle",
      ]);
      // X-PAYMENT-RESPONSE header round-trips through the client decoder.
      const decoded = JSON.parse(Buffer.from(result.paymentResponseHeader, "base64").toString("utf-8"));
      expect(decoded.success).toBe(true);
      expect(decoded.transaction).toBe("0xabc123");
    }
  });

  it("overpayment (>= required) is accepted at the required amount", async () => {
    const header = await signPaymentHeader({ value: 25_000n });
    const result = await processTapeXPayment(header, requirement(), facilitatorDeps());
    expect(result.ok).toBe(true);
  });
});

describe("facilitator payload parsers tolerate v1/v2/CDP shapes", () => {
  it("parses verify payloads", () => {
    expect(parseFacilitatorVerifyPayload({ isValid: true }).isValid).toBe(true);
    expect(parseFacilitatorVerifyPayload({ payment: { isValid: false, invalidReason: "bad nonce" } }))
      .toEqual({ isValid: false, invalidReason: "bad nonce" });
    expect(parseFacilitatorVerifyPayload(null).isValid).toBe(false);
    expect(parseFacilitatorVerifyPayload({ weird: true }).isValid).toBe(false);
  });

  it("parses settle payloads including nested transaction objects", () => {
    expect(parseFacilitatorSettlePayload({ success: true, transaction: "0x1" })?.transaction).toBe("0x1");
    expect(
      parseFacilitatorSettlePayload({ payment: { success: true, transaction: { hash: "0x2" } } })?.transaction,
    ).toBe("0x2");
    expect(parseFacilitatorSettlePayload({ success: false, errorMessage: "nope" })?.errorReason).toBe("nope");
    expect(parseFacilitatorSettlePayload({ nothing: true })).toBeNull();
  });

  it("encodes settlement headers as base64 JSON", () => {
    const header = encodeSettlementHeader({ success: true, transaction: "0x9" });
    expect(JSON.parse(Buffer.from(header, "base64").toString("utf-8"))).toEqual({
      success: true,
      transaction: "0x9",
    });
  });
});
