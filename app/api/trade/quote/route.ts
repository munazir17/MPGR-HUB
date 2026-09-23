import { NextResponse } from "next/server";

import { createRoutedSwapQuote } from "@/lib/trade/trade-swap-router";
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { withTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
import { estimateQuotePriceImpactBps } from "@/lib/trade/trade-price-impact";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { readJsonBody, requestIdFromRequest, withRequestId, verifyTrustedOrigin } from "@/lib/api/request-guard";
import { authenticateRequest } from "@/lib/auth/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 60_000;
// One upstream quote for an identical request inside this window (the
// tape's one-tap prepare and the agent tool can ask for the same swap).
const QUOTE_DEDUPE_MS = 6_000;

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const json = (body: unknown, init?: ResponseInit) => withRequestId(NextResponse.json(body, init), requestId);
  const originError = verifyTrustedOrigin(request);
  if (originError) return withRequestId(originError, requestId);
  const session = await authenticateRequest(request);
  if (!session) return json({ error: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const walletRate = await checkRateLimit(`${session.wallet.toLowerCase()}:trade-quote`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!walletRate.allowed) {
    return json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(walletRate.retryAfterSeconds) } },
    );
  }
  const ipRate = await checkRateLimit(`${clientIpFromRequest(request)}:trade-quote:ip`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!ipRate.allowed) {
    return json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(ipRate.retryAfterSeconds) } },
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

  const result = await withTradeQuoteCache(
    [
      "trade-quote",
      session.wallet.toLowerCase(),
      parsed.value.from.address.toLowerCase(),
      parsed.value.to.address.toLowerCase(),
      parsed.value.fromAmount,
      parsed.value.slippageBps,
    ].join(":"),
    QUOTE_DEDUPE_MS,
    () =>
      createRoutedSwapQuote({
        fromToken: parsed.value.from.address,
        toToken: parsed.value.to.address,
        fromAmount: parsed.value.fromAmount,
        taker: session.wallet,
        slippageBps: parsed.value.slippageBps,
      }),
  );

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

  // Price impact vs. the app's own mid price (tape). Null when a leg has
  // no live trusted price — the confirmation modal then says so instead
  // of showing a number nobody measured.
  const priceImpactBps = await estimateQuotePriceImpactBps({
    quote: result.value,
    fromAddress: parsed.value.from.address,
    toAddress: parsed.value.to.address,
    fromDecimals: parsed.value.from.decimals,
    toDecimals: parsed.value.to.decimals,
  });

  const proposal = buildTradeProposal({
    from: parsed.value.from,
    to: parsed.value.to,
    quote: result.value,
    slippageBps: parsed.value.slippageBps,
    taker: session.wallet,
    provider: result.provider,
    priceImpactBps,
  });

  if (!proposal.ok) {
    return json(
      { error: proposal.error.message, code: proposal.error.code },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  return json(
    { proposal: proposal.proposal },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
