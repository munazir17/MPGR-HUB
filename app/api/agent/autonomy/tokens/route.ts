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
// CHAIN-AWARE (audit MC-1 remediation): `?chainId=` selects the registry the
// policy for that chain will be validated against. Default 8453 (Base
// mainnet) — byte-for-byte the previous behaviour. 84532 returns the
// DELEGATED Base Sepolia registry (tUSD/tSTOCK/WETH), which is the only
// registry a Sepolia policy can resolve against.
//
// The response also reports whether delegated execution is addressable on the
// requested chain (`delegated.executor` / `delegated.configured`), so the UI
// can tell the user honestly whether a goal they authorize on that chain can
// ever execute, instead of showing a control that can never work.
//
// Minimal projection: address, symbol, decimals. Never raw MCP/RPC output.

import { isAutonomousAgentEnabled } from "@/lib/autonomy/config";
import { parsePolicyChainId, policyChainLabel, policyRegistryFor, delegatedExecutionConfigured } from "@/lib/autonomy/api-helpers";
import { delegatedExecutorAddressFor, isDelegatedChainId } from "@/lib/executor/delegated-executor";
import { findExecutorRoute } from "@/lib/executor/executor-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * `request` is OPTIONAL so the historical no-arg call shape keeps working
 * (and defaults to Base mainnet). Next.js always supplies it in production.
 */
export async function GET(request?: Request) {
  if (!isAutonomousAgentEnabled()) {
    return NextResponse.json({ error: "Not available", code: "AUTONOMY_DISABLED" }, { status: 404, headers: NO_STORE });
  }

  const searchParams = request ? new URL(request.url).searchParams : new URLSearchParams();
  const chain = parsePolicyChainId(searchParams.get("chainId"));
  if (!chain.ok) {
    return NextResponse.json({ error: "Invalid chain.", code: "INVALID_CHAIN", details: [chain.message] }, { status: 400, headers: NO_STORE });
  }
  const chainId = chain.chainId;

  const deployment = policyRegistryFor(chainId);
  if (!deployment) {
    return NextResponse.json(
      { error: `No executor registry for ${policyChainLabel(chainId)}.`, code: "EXECUTOR_NOT_CONFIGURED" },
      { status: 404, headers: NO_STORE },
    );
  }

  const tokens = deployment.tokens.map((token) => ({
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
  }));

  const pairs = tokens.flatMap((sell) =>
    tokens
      .filter((buy) => buy.address !== sell.address && findExecutorRoute(deployment, sell.address, buy.address) !== null)
      .map((buy) => ({ sell: sell.address, buy: buy.address })),
  );

  return NextResponse.json(
    {
      chainId,
      network: deployment.network,
      tokens,
      pairs,
      // Honest capability disclosure: can a goal authorized on THIS chain ever
      // actually execute, and against which contract?
      delegated: {
        supported: isDelegatedChainId(chainId),
        configured: delegatedExecutionConfigured(chainId),
        executor: delegatedExecutorAddressFor(chainId),
      },
    },
    { headers: NO_STORE },
  );
}
