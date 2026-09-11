import { NextResponse } from "next/server";

import { getRoutedSwapPrice } from "@/lib/trade/trade-swap-router";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { checkRateLimit } from "@/lib/trade/trade-rate-limit";
import { readJsonBody, requestIdFromRequest, withRequestId } from "@/lib/api/request-guard";
import { getSessionFromRequest } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const session = getSessionFromRequest(request);
  if (!session) {
    return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const rate = checkRateLimit(`${session.wallet.toLowerCase()}:trade-price`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return withRequestId(parsedBody.response, requestId);
  const body = parsedBody.value && typeof parsedBody.value === "object"
    ? { ...(parsedBody.value as Record<string, unknown>), taker: session.wallet }
    : parsedBody.value;

  const parsed = await parseTradeSwapRequest(body, { requireTaker: true });
  if (!parsed.ok) {
    return json(
      { error: parsed.error.message, code: parsed.error.code },
      { status: parsed.error.code === "WALLET_REQUIRED" ? 401 : 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await getRoutedSwapPrice({
    fromToken: parsed.value.from.address,
    toToken: parsed.value.to.address,
    fromAmount: parsed.value.fromAmount,
    taker: session.wallet,
    slippageBps: parsed.value.slippageBps,
  });

  if (!result.ok) {
    const status =
      result.error.code === "CREDENTIALS_MISSING"
        ? 503
        : result.error.code === "WALLET_REQUIRED"
          ? 401
          : 502;
    return json(
      { error: result.error.message, code: result.error.code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return json(
    {
      from: parsed.value.from,
      to: parsed.value.to,
      slippageBps: parsed.value.slippageBps,
      price: result.value,
      provider: result.provider,
      network: "base",
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
