import "server-only";

// lib/mcp/quote-id.ts
//
// Stateless, tamper-proof quote IDs for the MCP flow (works on serverless —
// no quote store). Format:  q1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>
// Key: HKDF-style domain-separated derivation from AUTH_SESSION_SECRET
// (existing server secret; never exposed, never NEXT_PUBLIC).
//
// prepare_trade only accepts a quoteId whose MAC verifies and that has not
// expired, and re-derives every economically relevant field from it — an agent
// cannot alter amounts, minOut, fee, recipient or route between quote and prepare.

import { createHmac, timingSafeEqual } from "node:crypto";

export const QUOTE_ID_VERSION = "q1";
export const QUOTE_TTL_SECONDS = 120;

export interface QuotePayload {
  v: 1;
  chainId: number;
  provider: "mpgr-executor" | "0x-native-fee";
  taker: string;
  sellToken: string;
  buyToken: string;
  sellNative: boolean;
  buyNative: boolean;
  sellAmount: string;
  expectedBuyAmount: string;
  slippageBps: number;
  feeBps: number;
  feeAmount: string;
  feeRecipient: string;
  /** Issued-at / expiry, unix seconds. */
  iat: number;
  exp: number;
}

export type QuoteIdError = { code: "QUOTE_SECRET_MISSING" | "QUOTE_ID_INVALID" | "QUOTE_EXPIRED"; message: string };

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function quoteKey(secret: string | undefined = process.env.AUTH_SESSION_SECRET): Buffer | null {
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update("mpgr-mcp-quote-id/v1").digest();
}

export function signQuoteId(
  payload: QuotePayload,
  secret?: string,
): { ok: true; quoteId: string } | { ok: false; error: QuoteIdError } {
  const key = quoteKey(secret);
  if (!key) {
    return {
      ok: false,
      error: { code: "QUOTE_SECRET_MISSING", message: "Server quote signing is not configured (AUTH_SESSION_SECRET)." },
    };
  }
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = b64url(createHmac("sha256", key).update(`${QUOTE_ID_VERSION}.${body}`).digest());
  return { ok: true, quoteId: `${QUOTE_ID_VERSION}.${body}.${mac}` };
}

export function verifyQuoteId(
  quoteId: unknown,
  nowSeconds: number,
  secret?: string,
): { ok: true; payload: QuotePayload } | { ok: false; error: QuoteIdError } {
  const key = quoteKey(secret);
  if (!key) {
    return {
      ok: false,
      error: { code: "QUOTE_SECRET_MISSING", message: "Server quote signing is not configured (AUTH_SESSION_SECRET)." },
    };
  }
  const invalid = { ok: false as const, error: { code: "QUOTE_ID_INVALID" as const, message: "quoteId is invalid or was modified." } };
  if (typeof quoteId !== "string" || quoteId.length > 4096) return invalid;
  const parts = quoteId.split(".");
  if (parts.length !== 3 || parts[0] !== QUOTE_ID_VERSION) return invalid;
  const expected = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const given = fromB64url(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalid;
  let payload: QuotePayload;
  try {
    payload = JSON.parse(fromB64url(parts[1]).toString("utf8")) as QuotePayload;
  } catch {
    return invalid;
  }
  if (payload?.v !== 1 || typeof payload.exp !== "number") return invalid;
  if (nowSeconds > payload.exp) {
    return { ok: false, error: { code: "QUOTE_EXPIRED", message: "Quote expired. Request a fresh quote." } };
  }
  return { ok: true, payload };
}
