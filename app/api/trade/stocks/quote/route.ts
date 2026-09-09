// app/api/trade/stocks/quote/route.ts
//
// POST /api/trade/stocks/quote
// Prepares an on-chain Base swap proposal for a Coinbase B20 tokenized
// stock (USDC ↔ AAPLc, etc.) via Aerodrome Slipstream. Never signs.
// Never uses Advanced Trade, CDP Trade API, or 0x for B20.

import { NextResponse } from "next/server";
import { isAddress } from "viem";

import { prepareTokenizedStockSwap } from "@/lib/trade/tokenized-stock-swap";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 15; // requests
const RATE_WINDOW_MS = 60_000;

function statusFor(code: string): number {
  if (code === "CREDENTIALS_MISSING") return 503;
  if (code === "INVALID_INPUT" || code === "UNSUPPORTED_ASSET") return 400;
  if (code === "WALLET_REQUIRED") return 401;
  if (code === "LIQUIDITY_UNAVAILABLE") return 409;
  return 502;
}

export async function POST(request: Request) {
  const rate = checkRateLimit(`${clientIpFromRequest(request)}:trade-stocks-quote`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : "";
  const side = body?.side === "SELL" ? "SELL" : "BUY";
  const amount = typeof body?.amount === "string" ? body.amount.trim() : "";
  const taker = typeof body?.taker === "string" ? body.taker.trim() : "";

  if (!symbol || !amount) {
    return NextResponse.json(
      { error: "symbol and amount are required.", code: "INVALID_INPUT" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isAddress(taker)) {
    return NextResponse.json(
      { error: "taker must be the connected Base wallet address.", code: "WALLET_REQUIRED" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await prepareTokenizedStockSwap({
    symbol,
    side,
    amountHuman: amount,
    taker,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error.message, code: result.error.code },
      { status: statusFor(result.error.code), headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { proposal: result.proposal, executed: false },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
