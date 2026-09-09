// app/api/trade/price/route.ts
//
// POST /api/trade/price
// Server-side Base swap price. Regular tokens: Coinbase CDP then 0x.
// Coinbase B20 tokenized stocks: Aerodrome Slipstream. Never signs.

import { NextResponse } from "next/server";

import { getRoutedSwapPrice } from "@/lib/trade/trade-swap-router";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 30; // requests
const RATE_WINDOW_MS = 60_000; // per minute

export async function POST(request: Request) {
  const rate = checkRateLimit(`${clientIpFromRequest(request)}:trade-price`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = await parseTradeSwapRequest(body, { requireTaker: true });
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error.message, code: parsed.error.code },
      { status: parsed.error.code === "WALLET_REQUIRED" ? 401 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await getRoutedSwapPrice({
    fromToken: parsed.value.from.address,
    toToken: parsed.value.to.address,
    fromAmount: parsed.value.fromAmount,
    taker: parsed.value.taker,
    slippageBps: parsed.value.slippageBps,
  });

  if (!result.ok) {
    const status =
      result.error.code === "CREDENTIALS_MISSING"
        ? 503
        : result.error.code === "WALLET_REQUIRED"
          ? 401
          : 502;
    return NextResponse.json(
      { error: result.error.message, code: result.error.code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      from: parsed.value.from,
      to: parsed.value.to,
      slippageBps: parsed.value.slippageBps,
      price: result.value,
      provider: result.provider,
      network: "base",
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
