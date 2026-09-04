// app/api/trade/quote/route.ts
//
// POST /api/trade/quote
// Server-side Coinbase CDP createSwapQuote. Returns unsigned calldata
// bound to `taker`. Never broadcasts.

import { NextResponse } from "next/server";

import { createCdpSwapQuote } from "@/lib/trade/trade-cdp-client";
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = parseTradeSwapRequest(body, { requireTaker: true });
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error.message, code: parsed.error.code },
      { status: parsed.error.code === "WALLET_REQUIRED" ? 401 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await createCdpSwapQuote({
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
