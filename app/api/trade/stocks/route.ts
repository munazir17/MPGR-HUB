// app/api/trade/stocks/route.ts
//
// GET /api/trade/stocks              → official B20 catalog
// GET /api/trade/stocks?symbol=AAPLc → on-chain + optional CDP liquidity
//
// No issuer mint/redeem. Execution stays research-only unless CDP
// reports secondary-market liquidity.

import { NextResponse } from "next/server";

import {
  buildTokenizedStockCatalog,
  researchTokenizedStock,
} from "@/lib/trade/trade-research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
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
