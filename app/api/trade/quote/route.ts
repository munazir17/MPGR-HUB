// app/api/trade/quote/route.ts
//
// POST /api/trade/quote
// Server-side Base swap quote. Regular tokens: Coinbase CDP then 0x.
// Coinbase B20 tokenized stocks: Aerodrome Slipstream. Never broadcasts.

import { NextResponse } from "next/server";

import { createRoutedSwapQuote } from "@/lib/trade/trade-swap-router";
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 15; // requests
const RATE_WINDOW_MS = 60_000; // per minute — quote creation is heavier than price

export async function POST(request: Request) {
  const rate = checkRateLimit(`${clientIpFromRequest(request)}:trade-quote`, RATE_LIMIT, RATE_WINDOW_MS);
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

  const result = await createRoutedSwapQuote({
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

  const proposal = buildTradeProposal({
    from: parsed.value.from,
    to: parsed.value.to,
    quote: result.value,
    slippageBps: parsed.value.slippageBps,
    taker: parsed.value.taker,
    provider: result.provider,
  });

  if (!proposal.ok) {
    return NextResponse.json(
      { error: proposal.error.message, code: proposal.error.code },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { proposal: proposal.proposal },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
