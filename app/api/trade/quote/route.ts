import { publicTradeError } from "@/lib/trade/trade-chat";
import { NextResponse } from "next/server";

import { createRoutedSwapQuote } from "@/lib/trade/trade-swap-router";
import { buildExecutorSwapProposal, isExecutorRoutablePair } from "@/lib/trade/trade-executor-quote";
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
      parsed.value.from.decimals,
      parsed.value.to.decimals,
      parsed.value.slippageBps,
    ].join(":"),
    QUOTE_DEDUPE_MS,
    async () => {
      const quotedAt = new Date();

      // 0. MPGR Executor first. It is the only route that collects the MPGR
      //    Agent fee, and it collects it inside the swap transaction (the
      //    wallet sends one tx to the executor — never a fee transfer). For
      //    pairs with a proven executor route this is authoritative: falling
      //    back to a non-executor venue would silently drop the fee, so a
      //    failed executor quote is returned as an error instead.
      if (isExecutorRoutablePair(parsed.value.from.address, parsed.value.to.address)) {
        const executorQuote = await buildExecutorSwapProposal({
          from: parsed.value.from,
          to: parsed.value.to,
          fromAmount: parsed.value.fromAmount,
          taker: session.wallet,
          slippageBps: parsed.value.slippageBps,
          quotedAt,
        });
        if (executorQuote.ok) {
          const priceImpactBps = await estimateQuotePriceImpactBps({
            quote: executorQuote.proposal,
            fromAddress: parsed.value.from.address,
            toAddress: parsed.value.to.address,
            fromDecimals: parsed.value.from.decimals,
            toDecimals: parsed.value.to.decimals,
          });
          return { ok: true as const, proposal: { ...executorQuote.proposal, priceImpactBps } };
        }
        if (executorQuote.supported) return { ok: false as const, error: executorQuote.error };
      }

      const quote = await createRoutedSwapQuote({
        fromToken: parsed.value.from.address,
        toToken: parsed.value.to.address,
        fromAmount: parsed.value.fromAmount,
        taker: session.wallet,
        slippageBps: parsed.value.slippageBps,
      });
      if (!quote.ok) return quote;
      if (quote.value.fromToken.toLowerCase() !== parsed.value.from.address.toLowerCase() ||
          quote.value.toToken.toLowerCase() !== parsed.value.to.address.toLowerCase() ||
          quote.value.fromAmount !== parsed.value.fromAmount) {
        return { ok: false as const, error: { code: "QUOTE_CHANGED" as const, message: "Quote does not match the requested swap." } };
      }
      if (!quote.value.liquidityAvailable || !quote.value.transaction) {
        return { ok: false as const, error: { code: "LIQUIDITY_UNAVAILABLE" as const, message: "No executable route." } };
      }
      const priceImpactBps = await estimateQuotePriceImpactBps({
        quote: quote.value,
        fromAddress: parsed.value.from.address,
        toAddress: parsed.value.to.address,
        fromDecimals: parsed.value.from.decimals,
        toDecimals: parsed.value.to.decimals,
      });
      return buildTradeProposal({
        from: parsed.value.from, to: parsed.value.to, quote: quote.value,
        slippageBps: parsed.value.slippageBps, taker: session.wallet,
        provider: quote.provider, quotedAt, priceImpactBps,
      });
    },
  );

  if (!result.ok) {
    const status =
      result.error.code === "CREDENTIALS_MISSING"
        ? 503
        : result.error.code === "WALLET_REQUIRED"
          ? 401
          : 502;
    return json(
      { error: publicTradeError(result.error), code: result.error.code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return json(
    { proposal: result.proposal },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
