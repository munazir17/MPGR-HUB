// lib/x402/x402-verification.ts
//
// P3 — decoding and verification for the resource server's response to
// a paid request. Per the x402 spec, a successful settlement is
// reported via a base64-JSON `X-PAYMENT-RESPONSE` header on the (now
// 200) resource response. This module never assumes success just
// because a request returned 200 — see classifyX402ResourceResponse
// below, which is the single place this distinction is made so
// x402-execution.ts doesn't have to re-derive it.

import type { X402Error, X402SettlementResponse } from "./x402-types";

/**
 * Safely base64-decodes and JSON-parses an X-PAYMENT-RESPONSE header
 * value. Returns null (never throws) for a missing/malformed header —
 * the caller treats that the same as "verification failed", never as
 * an implicit success.
 */
export function decodeSettlementResponseHeader(headerValue: string | null | undefined): X402SettlementResponse | null {
  if (!headerValue) return null;
  try {
    const json = typeof atob === "function" ? atob(headerValue) : Buffer.from(headerValue, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.success !== "boolean") return null;
    return {
      success: obj.success,
      transaction: typeof obj.transaction === "string" ? obj.transaction : undefined,
      network: typeof obj.network === "string" ? obj.network : undefined,
      payer: typeof obj.payer === "string" ? obj.payer : undefined,
      errorReason: typeof obj.errorReason === "string" ? obj.errorReason : undefined,
    };
  } catch {
    return null;
  }
}

export type X402ResourceOutcome =
  | { ok: true; settlement: X402SettlementResponse }
  | { ok: false; error: X402Error };

/**
 * Classifies the resource server's response to a paid (X-PAYMENT
 * header attached) request. Distinguishes the five outcomes the P3
 * spec requires:
 *   payment rejected    -> a fresh 402 (the payload wasn't accepted)
 *   payment failed       -> 200 but settlement.success === false
 *   resource request failed -> any other non-2xx status
 *   verification failed  -> 2xx with no valid settlement header
 *   resource returned successfully -> 2xx with settlement.success === true
 */
export function classifyX402ResourceResponse(
  status: number,
  settlementHeaderValue: string | null | undefined
): X402ResourceOutcome {
  if (status === 402) {
    return {
      ok: false,
      error: { code: "PAYMENT_REJECTED", message: "The resource server rejected this payment — it was not accepted." },
    };
  }

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      error: { code: "SUBMISSION_FAILED", message: `The resource request failed (HTTP ${status}) after payment was submitted.` },
    };
  }

  const settlement = decodeSettlementResponseHeader(settlementHeaderValue);
  if (!settlement) {
    return {
      ok: false,
      error: {
        code: "VERIFICATION_FAILED",
        message: "The resource responded successfully, but its payment settlement could not be verified.",
      },
    };
  }

  if (!settlement.success) {
    return {
      ok: false,
      error: { code: "PAYMENT_FAILED", message: settlement.errorReason ?? "The payment failed to settle on-chain." },
    };
  }

  return { ok: true, settlement };
}
