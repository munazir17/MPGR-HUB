// Swap-only read endpoint protection; never uses execution or Agent handlers.
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, verifyTrustedOrigin, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { SwapDiscoveryError } from "./swap-discovery-read";
export async function swapDiscoveryApi(request: Request, scope: "token" | "liquidity", action: (body: Record<string, unknown>) => Promise<object>) {
  const id = crypto.randomUUID();
  const reply = (data: object, status = 200) => withRequestId(NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } }), id);
  const origin = verifyTrustedOrigin(request); if (origin) return withRequestId(origin, id);
  const session = await authenticateRequest(request); if (!session) return reply({ error: "Sign in with your Base wallet for this read-only check." }, 401);
  for (const key of [`${session.wallet.toLowerCase()}:swap-${scope}`, `${clientIpFromRequest(request)}:swap-${scope}:ip`]) {
    if (!(await checkRateLimit(key, scope === "liquidity" ? 10 : 30, 60_000)).allowed) return reply({ error: "Too many Base checks. Wait briefly and retry." }, 429);
  }
  const body = await readJsonBody(request, 512); if (!body.ok) return withRequestId(body.response, id);
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value) || (body.value as Record<string, unknown>).chainId !== 8453) return reply({ error: "Use Base Mainnet (8453) and exact token contracts." }, 400);
  try { return reply(await action(body.value as Record<string, unknown>)); }
  catch (e) {
    if (e instanceof SwapDiscoveryError) return reply({ code: e.code, error: e.message }, e.status);
    return reply({ code: "BASE_READ_UNAVAILABLE", error: "The Base read-only check is temporarily unavailable. Retry; no trade was prepared." }, 503);
  }
}
