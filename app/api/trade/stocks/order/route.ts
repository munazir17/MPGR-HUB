// app/api/trade/stocks/order/route.ts
//
// POST /api/trade/stocks/order
// REAL execution — creates a live Coinbase Advanced Trade order for a
// B20 tokenized-stock ticker. This moves real funds.
//
// Same safety boundary as crypto swap execution: this route is only
// ever called from the Confirm UI after the user has seen a preview
// (POST /api/trade/stocks/quote) and explicitly confirmed. It is
// NEVER called directly by an agent tool — see the "no execute-mode
// trade tool" note in trade-tool-definitions.ts, which applies here
// too.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { executeTokenizedStockOrder } from "@/lib/trade/tokenized-stock-order";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFor(code: string): number {
  if (code === "CREDENTIALS_MISSING") return 503;
  if (code === "INVALID_INPUT" || code === "UNSUPPORTED_ASSET") return 400;
  if (code === "LIQUIDITY_UNAVAILABLE") return 409;
  return 502;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : "";
  const side = body?.side === "SELL" ? "SELL" : "BUY";
  const amount = typeof body?.amount === "string" ? body.amount.trim() : "";
  const confirmed = body?.confirmed === true;

  if (!symbol || !amount) {
    return NextResponse.json(
      { error: "symbol and amount are required.", code: "INVALID_INPUT" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!confirmed) {
    return NextResponse.json(
      {
        error: "This endpoint executes a real order. Set confirmed: true only after the user has approved the preview.",
        code: "INVALID_INPUT",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const clientOrderId = randomUUID();
  const result = await executeTokenizedStockOrder(symbol, side, amount, clientOrderId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error.message, code: result.error.code },
      { status: statusFor(result.error.code), headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      order: {
        ticker: result.value.catalog.ticker,
        productId: result.value.productId,
        side: result.value.side,
        orderId: result.value.order.orderId,
        clientOrderId,
        executed: true,
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
