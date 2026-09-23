// app/api/trade/stocks/quote/route.ts
//
// POST /api/trade/stocks/quote
// Prepares an on-chain Base swap proposal for a Coinbase B20 tokenized
// stock (USDC ↔ AAPLc, etc.) via Aerodrome Slipstream. Never signs.
// Never uses Advanced Trade, CDP Trade API, or 0x for B20.
// Taker is always the authenticated session wallet.

import { NextResponse } from "next/server";

import { prepareTokenizedStockSwap } from "@/lib/trade/tokenized-stock-swap";
import { withTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { readJsonBody, requestIdFromRequest, withRequestId, verifyTrustedOrigin } from "@/lib/api/request-guard";
import { authenticateRequest } from "@/lib/auth/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 60_000;
// One upstream Aerodrome quote for an identical request inside this
// window (the tape's one-tap prepare and the agent tool ask for the same
// swap).
const QUOTE_DEDUPE_MS = 6_000;

function statusFor(code: string): number {
  if (code === "CREDENTIALS_MISSING") return 503;
  if (code === "INVALID_INPUT" || code === "UNSUPPORTED_ASSET") return 400;
  if (code === "WALLET_REQUIRED") return 401;
  if (code === "LIQUIDITY_UNAVAILABLE") return 409;
  return 502;
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const session = await authenticateRequest(request);
  if (!session) {
    return json(
      { error: "Authentication required", code: "AUTH_REQUIRED" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const walletRate = await checkRateLimit(`${session.wallet.toLowerCase()}:trade-stocks-quote`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!walletRate.allowed) {
    return json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(walletRate.retryAfterSeconds) } },
    );
  }
  const ipRate = await checkRateLimit(`${clientIpFromRequest(request)}:trade-stocks-quote:ip`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!ipRate.allowed) {
    return json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(ipRate.retryAfterSeconds) } },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = parsedBody.value && typeof parsedBody.value === "object"
    ? (parsedBody.value as Record<string, unknown>)
    : null;
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : "";
  const side = body?.side === "SELL" ? "SELL" : "BUY";
  const amount = typeof body?.amount === "string" ? body.amount.trim() : "";

  if (!symbol || !amount) {
    return json(
      { error: "symbol and amount are required.", code: "INVALID_INPUT" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await withTradeQuoteCache(
    [
      "trade-stocks-quote",
      session.wallet.toLowerCase(),
      symbol.toUpperCase(),
      side,
      amount,
    ].join(":"),
    QUOTE_DEDUPE_MS,
    () =>
      prepareTokenizedStockSwap({
        symbol,
        side,
        amountHuman: amount,
        taker: session.wallet,
      }),
  );
  if (!result.ok) {
    return json(
      { error: result.error.message, code: result.error.code },
      { status: statusFor(result.error.code), headers: { "Cache-Control": "no-store" } },
    );
  }

  return json(
    { proposal: result.proposal, executed: false },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
