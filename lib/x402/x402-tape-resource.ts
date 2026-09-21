import "server-only";

// lib/x402/x402-tape-resource.ts
//
// Server side of the ONE paid endpoint this app sells:
//
//   GET /api/x402/tape — "MPGR / Base Stocks live tape snapshot"
//
// This module makes MPGR HUB an x402 RESOURCE SERVER. Everything else in
// lib/x402/ is the payer/client side (discover → prepare → sign →
// submit). Roles per the x402 spec:
//
//   1. Unpaid request  → 402 + payment requirements (buildTapePaymentRequiredBody)
//   2. Paid request    → decode X-PAYMENT, verify the buyer's EIP-3009
//      TransferWithAuthorization locally (amount/payTo/asset/network/
//      window/signature), then hand it to a facilitator: POST /verify
//      before doing work, POST /settle after, and only serve the tape
//      when settle reports on-chain success.
//   3. The 200 carries the base64 X-PAYMENT-RESPONSE settlement header
//      (same shape lib/x402/x402-verification.ts decodes as a client).
//
// Fail-closed rules:
//   - no X402_TAPE_PAY_TO configured → the endpoint is 503, never free
//   - any local check failure, facilitator rejection, or facilitator
//     outage → 402/503, never the tape
//   - the tape is served only AFTER settle success, so a failed
//     settlement never hands out paid data for free
//
// Facilitator: Coinbase CDP (https://api.cdp.coinbase.com/platform/v2/x402)
// with the repo's existing CDP Secret API Key JWT (lib/trade/trade-jwt.ts)
// when CDP_API_KEY_ID/CDP_API_KEY_SECRET are set; otherwise the public
// https://x402.org/facilitator (Base Sepolia only — mainnet settles will
// be rejected there, which is the correct fail-closed outcome).

import { getAddress, isAddress, verifyTypedData, type Address, type Hex } from "viem";

import { BASE_USDC } from "@/lib/trade/trade-config";
import { generateCdpJwt } from "@/lib/trade/trade-jwt";
import {
  KNOWN_X402_ASSET_DECIMALS,
  X402_CHAIN_ID,
  X402_SUPPORTED_NETWORK,
  resolveEip712Domain,
  x402NetworksEquivalent,
} from "./x402-config";
import { decodeXPaymentHeader } from "./x402-submit";
import {
  X402_TAPE_DESCRIPTION,
  X402_TAPE_MIME_TYPE,
  X402_TAPE_PATH,
} from "./x402-tape-info";
import type { X402PaymentRequirements, X402SettlementResponse } from "./x402-types";

// ---------------------------------------------------------------------------
// Config (env-driven, fail closed)
// ---------------------------------------------------------------------------

export {
  X402_TAPE_PATH,
  X402_TAPE_DESCRIPTION,
  X402_TAPE_MIME_TYPE,
} from "./x402-tape-info";

export const X402_TAPE_ASSET = BASE_USDC as Address;
export const X402_TAPE_ASSET_DECIMALS =
  KNOWN_X402_ASSET_DECIMALS[X402_TAPE_ASSET.toLowerCase()] ?? 6;
export const X402_TAPE_MAX_TIMEOUT_SECONDS = 60;

const DEFAULT_PRICE_USDC_RAW = 20_000n; // 0.02 USDC (6 decimals)
const PRICE_CAP_USDC_RAW = 1_000_000n; // refuse absurd misconfiguration (1 USDC)
const CDP_FACILITATOR_BASE = "https://api.cdp.coinbase.com/platform/v2/x402";
const PUBLIC_FACILITATOR_BASE = "https://x402.org/facilitator";
const FACILITATOR_TIMEOUT_MS = 15_000;

/** 0.02 USDC in atomic units by default; X402_TAPE_PRICE_USDC_RAW overrides. */
export function x402TapePriceUsdcRaw(): bigint {
  const raw = process.env.X402_TAPE_PRICE_USDC_RAW?.trim();
  if (!raw) return DEFAULT_PRICE_USDC_RAW;
  if (!/^[0-9]+$/.test(raw)) return DEFAULT_PRICE_USDC_RAW;
  try {
    const value = BigInt(raw);
    if (value <= 0n || value > PRICE_CAP_USDC_RAW) return DEFAULT_PRICE_USDC_RAW;
    return value;
  } catch {
    return DEFAULT_PRICE_USDC_RAW;
  }
}

/** Recipient of tape payments. Unset/invalid → endpoint disabled (503). */
export function x402TapePayTo(): Address | null {
  const raw = process.env.X402_TAPE_PAY_TO?.trim();
  if (!raw || !isAddress(raw)) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

export interface X402TapeFacilitatorConfig {
  baseUrl: string;
  /** Bearer JWT for the CDP facilitator; null for the keyless public one. */
  bearer: string | null;
  kind: "cdp" | "public";
}

export function x402TapeFacilitatorConfig(): X402TapeFacilitatorConfig | null {
  const override = process.env.X402_TAPE_FACILITATOR_URL?.trim();
  if (override) {
    let url: URL;
    try {
      url = new URL(override);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    return { baseUrl: override.replace(/\/+$/, ""), bearer: null, kind: "public" };
  }

  const keyId = process.env.CDP_API_KEY_ID?.trim();
  const keySecret = process.env.CDP_API_KEY_SECRET?.trim();
  if (keyId && keySecret) {
    try {
      const url = new URL(CDP_FACILITATOR_BASE);
      const bearer = generateCdpJwt({
        apiKeyId: keyId,
        apiKeySecret: keySecret,
        requestMethod: "POST",
        requestHost: url.host,
        requestPath: url.pathname,
      });
      return { baseUrl: CDP_FACILITATOR_BASE, bearer, kind: "cdp" };
    } catch {
      return null;
    }
  }

  return { baseUrl: PUBLIC_FACILITATOR_BASE, bearer: null, kind: "public" };
}

// ---------------------------------------------------------------------------
// 402 Payment Required body
// ---------------------------------------------------------------------------

/** v1+v2 compatible requirement entry for the tape. */
export function buildTapePaymentRequirement(
  resourceUrl: string,
  payTo: Address,
): X402PaymentRequirements & { amount: string } {
  const amount = x402TapePriceUsdcRaw().toString();
  const domain = resolveEip712Domain(X402_TAPE_ASSET, undefined);
  return {
    scheme: "exact",
    network: X402_SUPPORTED_NETWORK,
    wireNetwork: X402_SUPPORTED_NETWORK,
    maxAmountRequired: amount,
    // v2 name — published alongside maxAmountRequired for v1 payers.
    amount,
    resource: resourceUrl,
    description: X402_TAPE_DESCRIPTION,
    mimeType: X402_TAPE_MIME_TYPE,
    payTo,
    maxTimeoutSeconds: X402_TAPE_MAX_TIMEOUT_SECONDS,
    asset: X402_TAPE_ASSET,
    extra: {
      name: domain?.domain.name ?? "USD Coin",
      version: domain?.domain.version ?? "2",
      // Display metadata only — payers must still use the atomic amount.
      decimals: X402_TAPE_ASSET_DECIMALS,
    },
  };
}

export function buildTapePaymentRequiredBody(
  resourceUrl: string,
  payTo: Address,
  reason?: string,
): { x402Version: number; accepts: unknown[]; error?: string } {
  const requirement = buildTapePaymentRequirement(resourceUrl, payTo);
  return {
    x402Version: 2,
    accepts: [requirement],
    ...(reason ? { error: reason } : {}),
  };
}

/** Absolute resource URL for the 402 body (request URL, APP_ORIGIN fallback). */
export function tapeResourceUrl(requestUrl?: string | null): string {
  if (requestUrl) {
    try {
      const url = new URL(requestUrl);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return `${url.origin}${X402_TAPE_PATH}`;
      }
    } catch {
      // fall through
    }
  }
  const origin = process.env.APP_ORIGIN?.trim();
  if (origin) return `${origin.replace(/\/+$/, "")}${X402_TAPE_PATH}`;
  return X402_TAPE_PATH;
}

// ---------------------------------------------------------------------------
// Payment verification (local EIP-3009 checks + facilitator verify/settle)
// ---------------------------------------------------------------------------

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type X402TapeFailureCode =
  | "MISSING_PAYMENT"
  | "INVALID_PAYMENT"
  | "PAYMENT_REJECTED"
  | "FACILITATOR_UNAVAILABLE";

export type X402TapePaymentResult =
  | {
      ok: true;
      payer: Address;
      settlement: X402SettlementResponse;
      /** Base64-JSON settlement header for the 200 response. */
      paymentResponseHeader: string;
    }
  | { ok: false; code: X402TapeFailureCode; message: string };

export interface X402TapeFacilitatorDeps {
  nowSeconds(): number;
  postJson(
    url: string,
    body: unknown,
    bearer: string | null,
  ): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> | null }>;
}

function defaultFacilitatorDeps(): X402TapeFacilitatorDeps {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    async postJson(url, body, bearer) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
        });
        const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        return { ok: response.ok, status: response.status, payload };
      } catch {
        return { ok: false, status: 0, payload: null };
      }
    },
  };
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Tolerant reader for facilitator verify responses across v1/v2/CDP shapes. */
export function parseFacilitatorVerifyPayload(
  payload: Record<string, unknown> | null,
): { isValid: boolean; invalidReason: string | null } {
  if (!payload) return { isValid: false, invalidReason: "empty facilitator response" };
  const candidate =
    typeof payload.isValid === "boolean"
      ? payload
      : payload.payment && typeof payload.payment === "object"
        ? (payload.payment as Record<string, unknown>)
        : null;
  if (!candidate || typeof candidate.isValid !== "boolean") {
    return { isValid: false, invalidReason: "unparseable facilitator response" };
  }
  const reason =
    typeof candidate.invalidReason === "string"
      ? candidate.invalidReason
      : typeof candidate.invalidMessage === "string"
        ? candidate.invalidMessage
        : null;
  return { isValid: candidate.isValid, invalidReason: reason };
}

/** Tolerant reader for facilitator settle responses across v1/v2/CDP shapes. */
export function parseFacilitatorSettlePayload(
  payload: Record<string, unknown> | null,
): X402SettlementResponse | null {
  if (!payload) return null;
  const candidate =
    typeof payload.success === "boolean"
      ? payload
      : payload.payment && typeof payload.payment === "object"
        ? (payload.payment as Record<string, unknown>)
        : null;
  if (!candidate || typeof candidate.success !== "boolean") return null;

  let transaction: string | undefined;
  if (typeof candidate.transaction === "string") transaction = candidate.transaction;
  else if (candidate.transaction && typeof candidate.transaction === "object") {
    const tx = candidate.transaction as Record<string, unknown>;
    if (typeof tx.hash === "string") transaction = tx.hash;
    else if (typeof tx.transactionHash === "string") transaction = tx.transactionHash;
  }
  if (typeof candidate.transactionHash === "string") transaction = candidate.transactionHash;

  return {
    success: candidate.success,
    transaction,
    network: typeof candidate.network === "string" ? candidate.network : undefined,
    payer: typeof candidate.payer === "string" ? candidate.payer : undefined,
    errorReason:
      typeof candidate.errorReason === "string"
        ? candidate.errorReason
        : typeof candidate.errorMessage === "string"
          ? candidate.errorMessage
          : undefined,
  };
}

export function encodeSettlementHeader(settlement: X402SettlementResponse): string {
  return Buffer.from(JSON.stringify(settlement), "utf-8").toString("base64");
}

/**
 * Full paid-request pipeline for the tape. `xPaymentHeader` is the raw
 * X-PAYMENT / PAYMENT-SIGNATURE header value. Returns the settlement to
 * report on the 200, or a typed failure the route turns into 402/503.
 */
export async function processTapeXPayment(
  xPaymentHeader: string | null,
  requirement: X402PaymentRequirements,
  deps: X402TapeFacilitatorDeps = defaultFacilitatorDeps(),
): Promise<X402TapePaymentResult> {
  if (!xPaymentHeader) {
    return { ok: false, code: "MISSING_PAYMENT", message: "No payment header was provided." };
  }

  const facilitator = x402TapeFacilitatorConfig();
  if (!facilitator) {
    return {
      ok: false,
      code: "FACILITATOR_UNAVAILABLE",
      message: "Payment facilitation is not configured.",
    };
  }

  // 1. Decode + structural validation (shared with the payer-side submit
  //    path — same strict shape checks, never throws).
  const payment = decodeXPaymentHeader(xPaymentHeader);
  if (!payment) {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment header is not a valid x402 exact-scheme payload." };
  }
  if (!x402NetworksEquivalent(payment.network, requirement.network)) {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment was signed for a different network. Only Base Mainnet is accepted." };
  }

  const auth = payment.payload.authorization;

  // 2. Local binding checks against OUR advertised requirement — the
  //    buyer must have signed exactly this asset/payTo/amount/window.
  if (!addressesEqual(auth.to, requirement.payTo)) {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment recipient does not match this resource's payTo address." };
  }
  let value: bigint;
  let requiredAmount: bigint;
  try {
    value = BigInt(auth.value);
    requiredAmount = BigInt(requirement.maxAmountRequired);
  } catch {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment amount is not a valid integer." };
  }
  if (value < requiredAmount) {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment amount is below the required price." };
  }

  const nowSeconds = BigInt(deps.nowSeconds());
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment validity window is not valid." };
  }
  if (validAfter > nowSeconds) {
    return { ok: false, code: "INVALID_PAYMENT", message: "This payment authorization is not valid yet." };
  }
  if (validBefore <= nowSeconds) {
    return { ok: false, code: "INVALID_PAYMENT", message: "This payment authorization has expired." };
  }

  // 3. Local EIP-3009 signature check (USDC domain, Base chain id).
  const domainConfig = resolveEip712Domain(requirement.asset, requirement.extra);
  if (!domainConfig) {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment asset has no known EIP-712 domain." };
  }
  if (!addressesEqual(requirement.asset, X402_TAPE_ASSET)) {
    return { ok: false, code: "INVALID_PAYMENT", message: "Only native USDC on Base is accepted for the tape." };
  }
  const domain = {
    name: domainConfig.domain.name,
    version: domainConfig.domain.version,
    chainId: X402_CHAIN_ID,
    verifyingContract: getAddress(requirement.asset),
  };
  const payer = getAddress(auth.from);
  let signatureValid = false;
  try {
    signatureValid = await verifyTypedData({
      address: payer,
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payer,
        to: getAddress(auth.to),
        value,
        validAfter,
        validBefore,
        nonce: auth.nonce as Hex,
      },
      signature: payment.payload.signature as Hex,
    });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, code: "INVALID_PAYMENT", message: "The payment signature does not match the payer or the authorization." };
  }

  // 4. Facilitator verify → settle. The wire body follows the x402 v2
  //    facilitator shape ({ x402Version, paymentPayload, paymentRequirements }).
  const acceptedRequirement = {
    scheme: "exact",
    network: requirement.network,
    asset: requirement.asset,
    amount: requirement.maxAmountRequired,
    maxAmountRequired: requirement.maxAmountRequired,
    payTo: requirement.payTo,
    resource: requirement.resource,
    description: requirement.description,
    mimeType: requirement.mimeType,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    extra: requirement.extra,
  };
  const wirePayload = {
    x402Version: payment.x402Version,
    scheme: "exact" as const,
    network: payment.network,
    payload: payment.payload,
    accepted: {
      scheme: "exact" as const,
      network: requirement.network,
      amount: requirement.maxAmountRequired,
      asset: requirement.asset,
      payTo: requirement.payTo,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds,
      extra: requirement.extra,
    },
    resource: {
      url: requirement.resource,
      description: requirement.description,
      mimeType: requirement.mimeType,
    },
  };
  const facilitatorBody = {
    x402Version: 2,
    paymentPayload: wirePayload,
    paymentRequirements: acceptedRequirement,
  };

  const verifyResponse = await deps.postJson(
    `${facilitator.baseUrl}/verify`,
    facilitatorBody,
    facilitator.bearer,
  );
  const verify = parseFacilitatorVerifyPayload(verifyResponse.payload);
  if (!verifyResponse.ok && verifyResponse.status >= 500) {
    return {
      ok: false,
      code: "FACILITATOR_UNAVAILABLE",
      message: "The payment facilitator is unavailable. No payment was taken; retry shortly.",
    };
  }
  if (!verify.isValid) {
    return {
      ok: false,
      code: "PAYMENT_REJECTED",
      message: verify.invalidReason
        ? `The payment facilitator rejected this payment: ${verify.invalidReason}`
        : "The payment facilitator rejected this payment.",
    };
  }

  const settleResponse = await deps.postJson(
    `${facilitator.baseUrl}/settle`,
    facilitatorBody,
    facilitator.bearer,
  );
  const settlement = parseFacilitatorSettlePayload(settleResponse.payload);
  if (!settleResponse.ok && settleResponse.status >= 500) {
    return {
      ok: false,
      code: "FACILITATOR_UNAVAILABLE",
      message: "The payment facilitator could not settle this payment. No tape was served; retry shortly.",
    };
  }
  if (!settlement || !settlement.success) {
    return {
      ok: false,
      code: "PAYMENT_REJECTED",
      message: settlement?.errorReason
        ? `The payment failed to settle on-chain: ${settlement.errorReason}`
        : "The payment failed to settle on-chain.",
    };
  }

  const fullSettlement: X402SettlementResponse = {
    success: true,
    transaction: settlement.transaction,
    network: settlement.network ?? requirement.network,
    payer: settlement.payer ?? payer,
  };

  return {
    ok: true,
    payer,
    settlement: fullSettlement,
    paymentResponseHeader: encodeSettlementHeader(fullSettlement),
  };
}
