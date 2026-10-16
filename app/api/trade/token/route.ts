// Read-only Base import. Same trust/auth/rate/body gates as the quote/price APIs.
import { NextResponse } from "next/server";
import { verifyTrustedOrigin, readJsonBody, withRequestId } from "@/lib/api/request-guard";
import { authenticateRequest } from "@/lib/auth/session-store";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { resolveSwapToken } from "@/lib/trade/trade-token-resolution";
import { isAddress } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const headers = { "Cache-Control": "no-store", "X-Request-Id": requestId };
  const reply = (data: object, status = 200) => NextResponse.json({ ...data, requestId }, { status, headers });
  const guarded = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return withRequestId(response, requestId); };
  const originError = verifyTrustedOrigin(request);
  if (originError) return guarded(originError);
  const session = await authenticateRequest(request);
  if (!session) return reply({ error: "Sign in with your wallet to validate a Base token.", code: "AUTH_REQUIRED" }, 401);
  const walletRate = await checkRateLimit(`${session.wallet.toLowerCase()}:trade-token`, 30, 60_000);
  const ipRate = walletRate.allowed ? await checkRateLimit(`${clientIpFromRequest(request)}:trade-token:ip`, 30, 60_000) : walletRate;
  if (!walletRate.allowed || !ipRate.allowed) return reply({ error: "Too many token checks. Wait and retry.", code: "RATE_LIMITED" }, 429);
  const parsed = await readJsonBody(request, 1024);
  if (!parsed.ok) return guarded(parsed.response);
  const body = parsed.value as { address?: unknown; chainId?: unknown } | null;
  if (!body || body.chainId !== 8453) return reply({ error: "Token import supports Base Mainnet (8453) only.", code: "UNSUPPORTED_NETWORK" }, 400);
  if (typeof body.address !== "string" || !isAddress(body.address, { strict: false })) return reply({ error: "Provide an exact Base token contract: 0x and 40 hexadecimal characters.", code: "INVALID_ADDRESS" }, 400);
  const result = await resolveSwapToken(body.address);
  if (!result.ok) return reply({ error: result.error.message, code: result.error.code }, result.error.code === "PROVIDER_ERROR" ? 503 : 400);
  return reply({ token: result.token, chainId: 8453 });
}
