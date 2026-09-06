// app/api/trade/stocks/order/route.ts
//
// Custodial Coinbase Advanced Trade execute is intentionally disabled.
// Public MPGR Agent fills are on-chain Base swaps confirmed through
// hooks/useTradeQuote (same path as ETH/USDC/MPGR). Advanced Trade
// would spend the API-key owner's Coinbase portfolio, not the user's
// wallet, and would not deliver B20 tokens on Base.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    {
      error:
        "Custodial Advanced Trade execute is disabled. Buy/sell Coinbase tokenized stocks (B20) as a Base swap: prepare via the agent, then confirm in your wallet.",
      code: "EXECUTION_UNAVAILABLE",
    },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
