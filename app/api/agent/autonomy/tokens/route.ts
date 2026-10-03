import { NextResponse } from "next/server";

// GET /api/agent/autonomy/tokens
//
// Autonomous Agent Runtime (ADDITIVE) — returns the executor-allowlisted
// token list so the UI can render a token picker without hard-coding any
// production address client-side. This is the SAME list the policy engine
// enforces (policy POST rejects non-allowlisted addresses), so the UI can
// never offer a token the server would refuse. Flag-gated like every other
// autonomy route (404 when the runtime is off). Read-only; no auth needed
// beyond the flag because nothing here is user-specific or secret.
//
// Minimal projection: address, symbol, decimals. Never raw MCP/RPC output.

import { isAutonomousAgentEnabled } from "@/lib/autonomy/config";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT } from "@/lib/executor/executor-config";
import { executorRouteExists } from "@/lib/autonomy/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  if (!isAutonomousAgentEnabled()) {
    return NextResponse.json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: NO_STORE });
  }

  const tokens = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.map((token) => ({
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
  }));

  const pairs = tokens.flatMap((sell) =>
    tokens
      .filter((buy) => buy.address !== sell.address && executorRouteExists(sell.address, buy.address))
      .map((buy) => ({ sell: sell.address, buy: buy.address })),
  );

  return NextResponse.json({ chainId: 8453, tokens, pairs }, { headers: NO_STORE });
}
