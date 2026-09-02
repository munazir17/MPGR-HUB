import { describe, expect, it } from "vitest";

import { X402_SUPPORTED_NETWORK } from "@/lib/x402/x402-config";
import { parseX402PaymentRequired } from "@/lib/x402/x402-parse";

import {
  agentKit402ToPaymentRequiredBody,
  isAgentKitRawX402,
  mapAgentKitHttpResult,
  normalizeBaseNetwork,
  normalizeRawX402Body,
  parseAgentKitResult,
  type AgentKitHttp402,
  type AgentKitPaymentOption,
} from "../map-x402";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const RESOURCE = "https://api.example.com/paid";

function agentKit402(
  overrides: Partial<AgentKitPaymentOption> = {},
): AgentKitHttp402 {
  return {
    status: "error_402_payment_required",
    acceptablePaymentOptions: [
      {
        scheme: "exact",
        network: "base",
        asset: USDC,
        maxAmountRequired: "1000000",
        payTo: PAY_TO,
        resource: RESOURCE,
        extra: { name: "USDC", version: "2" },
        ...overrides,
      },
    ],
  };
}

describe("AgentKit x402 mapping", () => {
  it("normalizes Base network aliases onto eip155:8453 and never invents other chains", () => {
    expect(normalizeBaseNetwork("base")).toBe(X402_SUPPORTED_NETWORK);
    expect(normalizeBaseNetwork("base-mainnet")).toBe(X402_SUPPORTED_NETWORK);
    expect(normalizeBaseNetwork("eip155:8453")).toBe(X402_SUPPORTED_NETWORK);
    expect(normalizeBaseNetwork("eip155:1")).toBe("eip155:1");
    expect(normalizeBaseNetwork(12)).toBe("");
  });

  it("copies amount, asset, and payTo from AgentKit — never invents them", () => {
    const body = agentKit402ToPaymentRequiredBody(agentKit402(), RESOURCE);
    const option = (body.accepts as Array<Record<string, unknown>>)[0];

    expect(option.maxAmountRequired).toBe("1000000");
    expect(option.asset).toBe(USDC);
    expect(option.payTo).toBe(PAY_TO);
    expect(option.network).toBe(X402_SUPPORTED_NETWORK);
    expect(JSON.stringify(body)).not.toContain("999999999");
  });

  it("does not invent an amount when AgentKit omitted it", () => {
    const body = agentKit402ToPaymentRequiredBody(
      agentKit402({ maxAmountRequired: undefined, amount: undefined }),
      RESOURCE,
    );
    const option = (body.accepts as Array<Record<string, unknown>>)[0];
    expect(option.maxAmountRequired).toBe("");
  });

  it("produces a 402 body the existing parser accepts after network alias rewrite", () => {
    const mapped = mapAgentKitHttpResult(agentKit402(), RESOURCE);
    expect(mapped.status).toBe(402);
    const parsed = parseX402PaymentRequired(mapped.body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.requirements[0].requirement.maxAmountRequired).toBe(
        "1000000",
      );
      expect(parsed.requirements[0].requirement.network).toBe(
        X402_SUPPORTED_NETWORK,
      );
    }
  });

  it("maps a successful AgentKit HTTP result without inventing a 402 body", () => {
    const mapped = mapAgentKitHttpResult(
      {
        success: true,
        url: RESOURCE,
        method: "GET",
        status: 200,
        data: { ok: true },
      },
      RESOURCE,
    );
    expect(mapped.status).toBe(200);
    expect(mapped.body).toBeNull();
  });

  it("recognizes a raw x402 body (x402Version + accepts) as a distinct shape", () => {
    expect(
      isAgentKitRawX402({
        x402Version: 1,
        accepts: [{ scheme: "exact", network: "base-sepolia" }],
      }),
    ).toBe(true);

    // Not raw x402 — must not be misdetected as this shape.
    expect(isAgentKitRawX402({ success: true, status: 200 })).toBe(false);
    expect(isAgentKitRawX402({ x402Version: 1 })).toBe(false);
  });

  it("maps a raw x402 AgentKit result (x402Version + accepts) to a 402, not status 0", () => {
    const mapped = mapAgentKitHttpResult(
      {
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base",
            asset: USDC,
            maxAmountRequired: "1000000",
            payTo: PAY_TO,
            resource: RESOURCE,
          },
        ],
      },
      RESOURCE,
    );

    expect(mapped.status).toBe(402);
    const body = mapped.body as { accepts: Array<Record<string, unknown>> };
    expect(body.accepts[0].network).toBe(X402_SUPPORTED_NETWORK);
    expect(body.accepts[0].maxAmountRequired).toBe("1000000");
    expect(body.accepts[0].payTo).toBe(PAY_TO);
  });

  it("normalizeRawX402Body only rewrites network — never invents amount/asset/payTo", () => {
    const normalized = normalizeRawX402Body({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          asset: "0xSepoliaUSDC",
          maxAmountRequired: "1000",
          payTo: PAY_TO,
          resource: RESOURCE,
          maxTimeoutSeconds: 300,
        },
      ],
    });

    const option = (normalized.accepts as Array<Record<string, unknown>>)[0];
    // Base Sepolia is not an alias of the supported mainnet network, so
    // it passes through unchanged rather than being coerced onto 8453.
    expect(option.network).toBe("base-sepolia");
    expect(option.maxAmountRequired).toBe("1000");
    expect(option.asset).toBe("0xSepoliaUSDC");
    expect(option.maxTimeoutSeconds).toBe(300);
  });

  it("does not misclassify a raw x402 body as a plain HTTP success", () => {
    const mapped = mapAgentKitHttpResult(
      { x402Version: 1, accepts: [] },
      RESOURCE,
    );
    expect(mapped.status).toBe(402);
    expect(mapped.status).not.toBe(0);
  });

  it("keeps plaintext AgentKit results (wallet details) instead of marking them as errors", () => {
    expect(parseAgentKitResult("Wallet Details:\n- Network ID: base-mainnet")).toBe(
      "Wallet Details:\n- Network ID: base-mainnet",
    );
    expect(parseAgentKitResult('{"success":true,"status":402}')).toEqual({
      success: true,
      status: 402,
    });
  });
});
