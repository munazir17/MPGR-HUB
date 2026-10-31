// Kyber / LI.FI cannot be proven to collect the 0.25% sell-token fee.
// This route used to return their calldata as a fallback. It now refuses,
// so a quote outage cannot silently become an unfee'd swap.
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { verifyTrustedOrigin } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { PUBLIC_ROUTER_FEE_BLOCK } from "@/lib/swap/route-desk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const origin = verifyTrustedOrigin(request);
  if (origin) return origin;
  const session = await authenticateRequest(request);
  if (!session) return reply({ code: "AUTH_REQUIRED", error: "Sign in with your connected Base wallet to request a swap quote." }, 401);
  for (const key of [`${session.wallet.toLowerCase()}:trade-quote`, `${clientIpFromRequest(request)}:trade-quote:ip`]) {
    if (!(await checkRateLimit(key, 15, 60_000)).allowed) return reply({ code: "RATE_LIMITED", error: "Too many quote requests. Wait briefly and retry." }, 429);
  }
  return reply({ code: "EXECUTION_UNAVAILABLE", error: PUBLIC_ROUTER_FEE_BLOCK }, 422);
}
