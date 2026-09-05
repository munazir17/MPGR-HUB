// app/api/trade/stocks/quote/route.ts
//
// POST /api/trade/stocks/quote
// Dry-run only. Calls Coinbase Advanced Trade's /orders/preview for a
// B20 tokenized-stock ticker. Never creates a real order.

import { NextResponse } from "next/server";

import { previewTokenizedStockOrder } from "@/lib/trade/tokenized-stock-order";

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

  if (!symbol || !amount) {
    return NextResponse.json(
      { error: "symbol and amount are required.", code: "INVALID_INPUT" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await previewTokenizedStockOrder(symbol, side, amount);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error.message, code: result.error.code },
      { status: statusFor(result.error.code), headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      preview: {
        ticker: result.value.catalog.ticker,
        underlyingTicker: result.value.catalog.underlyingTicker,
        productId: result.value.productId,
        side: result.value.side,
        quoteAmount: result.value.quoteAmount,
        orderTotal: result.value.preview.orderTotal,
        commissionTotal: result.value.preview.commissionTotal,
        estimatedBaseSize: result.value.preview.baseSize,
        averageFilledPrice: result.value.preview.averageFilledPrice,
        slippage: result.value.preview.slippage,
        warning: result.value.preview.warning,
        executed: false,
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
