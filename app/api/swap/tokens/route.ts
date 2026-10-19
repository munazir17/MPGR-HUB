import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, verifyTrustedOrigin, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { searchSwapTokenHints } from "@/lib/swap/swap-token-discovery";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const id = crypto.randomUUID();
  const reply = (data: object, status = 200) => withRequestId(NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } }), id);
  const origin = verifyTrustedOrigin(request); if (origin) return withRequestId(origin, id);
  const session = await authenticateRequest(request); if (!session) return reply({ error: "Sign in with your Base wallet to search more tokens." }, 401);
  for (const key of [`${session.wallet.toLowerCase()}:swap-tokens`, `${clientIpFromRequest(request)}:swap-tokens:ip`]) {
    if (!(await checkRateLimit(key, 20, 60_000)).allowed) return reply({ error: "Too many token searches. Wait briefly and retry." }, 429);
  }
  const body = await readJsonBody(request, 512); if (!body.ok) return withRequestId(body.response, id);
  const value = body.value as { query?: unknown; chainId?: unknown } | null;
  if (!value || value.chainId !== 8453 || typeof value.query !== "string" || value.query.trim().length < 2 || value.query.length > 64) return reply({ error: "Search 2–64 characters on Base Mainnet (8453)." }, 400);
  try { return reply({ chainId: 8453, source: "Uniswap default token list", tokens: await searchSwapTokenHints(value.query) }); }
  catch { return reply({ code: "DISCOVERY_UNAVAILABLE", error: "Base token search is temporarily unavailable. Retry or paste the exact Base contract to check it." }, 503); }
}
