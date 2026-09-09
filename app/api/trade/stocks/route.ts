// app/api/trade/stocks/route.ts
//
// GET /api/trade/stocks              → official B20 catalog
// GET /api/trade/stocks?symbol=AAPLc → on-chain + Aerodrome USDC liquidity
//
// No issuer mint/redeem. Execution stays research-only unless Aerodrome
// Slipstream reports a live USDC pool quote.

import { NextResponse } from "next/server";

import {
  buildTokenizedStockCatalog,
  researchTokenizedStock,
} from "@/lib/trade/trade-research";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 60; // requests — read-only catalog/research, higher budget
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  const rate = checkRateLimit(`${clientIpFromRequest(request)}:trade-stocks-research`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.trim() || "";
  const taker = url.searchParams.get("taker")?.trim() || undefined;

  if (!symbol) {
    return NextResponse.json(buildTokenizedStockCatalog(), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const result = await researchTokenizedStock(symbol, taker);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error.message, code: result.error.code },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(result.report, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
