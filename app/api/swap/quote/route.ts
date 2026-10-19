// Strict Swap surface only. No Agent API changes, aggregator fallback or signing.
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, requestIdFromRequest, verifyTrustedOrigin, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { estimateQuotePriceImpactBps } from "@/lib/trade/trade-price-impact";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment, findExecutorToken } from "@/lib/executor/executor-config";
import { searchSwapRoutes } from "@/lib/swap/swap-route-search";
import { verifyQualifiedSwapBlock, SwapRouteQualificationError } from "@/lib/swap/swap-route-selection";
import { swapPairIssue, swapPoolAsset, swapRouteIssue } from "@/lib/swap/swap-capability";
import { swapQuotePolicyError } from "@/lib/swap/swap-policy";
import { swapQuoteFresh } from "@/lib/swap/swap-lifecycle";
import { swapPathPairEligible } from "@/lib/swap/swap-path-quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const reply = (data: unknown, status = 200, extra: Record<string, string> = {}) => withRequestId(NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", ...extra } }), requestId);
  const origin = verifyTrustedOrigin(request); if (origin) return withRequestId(origin, requestId);
  const session = await authenticateRequest(request);
  if (!session) return reply({ code: "AUTH_REQUIRED", error: "Sign in with your connected Base wallet to request a swap quote." }, 401);
  // Same budget as the legacy endpoint: changing surfaces cannot evade limits.
  for (const key of [`${session.wallet.toLowerCase()}:trade-quote`, `${clientIpFromRequest(request)}:trade-quote:ip`]) {
    const limit = await checkRateLimit(key, 15, 60_000);
    if (!limit.allowed) return reply({ code: "RATE_LIMITED", error: "Too many quote requests. Wait briefly and retry." }, 429, { "Retry-After": String(limit.retryAfterSeconds) });
  }
  const read = await readJsonBody(request); if (!read.ok) return withRequestId(read.response, requestId);
  if (!read.value || typeof read.value !== "object" || Array.isArray(read.value)) return reply({ code: "INVALID_INPUT", error: "Provide a swap request object." }, 400);
  const body = read.value as Record<string, unknown>;
  // Policy belongs to this endpoint, not a caller-controlled flag.
  if ("requireMPGRFee" in body && body.requireMPGRFee !== true) return reply({ code: "SWAP_FEE_REQUIRED", error: "MPGR Swap always requires the atomic 0.25% fee. It cannot be disabled." }, 400);
  if (("refreshQuote" in body && typeof body.refreshQuote !== "boolean") || ("chainId" in body && body.chainId !== 8453)) return reply({ code: "INVALID_INPUT", error: "Use Base Mainnet (8453) and a boolean refreshQuote value." }, 400);
  if (typeof body.fromToken !== "string" || typeof body.toToken !== "string") return reply({ code: "INVALID_ADDRESS", error: "Select exact Base asset addresses." }, 400);
  const pair = swapPairIssue(body.fromToken, body.toToken); if (pair) return reply({ code: pair.code, error: pair.message }, 400);
  // A legacy-catalog miss is not a quote veto. Same-asset and invalid addresses
  // already failed above. Path search quotes any other pair and still enforces
  // the atomic 25 bps fee; no pool means LIQUIDITY_UNAVAILABLE.
  const pathEligible = swapPathPairEligible(body.fromToken, body.toToken);
  const capability = swapRouteIssue(body.fromToken, body.toToken);
  if (capability && !pathEligible) return reply({ code: "EXECUTION_UNAVAILABLE", reason: capability.code, error: capability.message }, 422);
  try {
    if (await getTradePublicClient().getChainId() !== 8453) return reply({ code: "PROVIDER_ERROR", reason: "UNSUPPORTED_NETWORK", error: "Base Mainnet could not be verified." }, 503);
  } catch { return reply({ code: "PROVIDER_ERROR", error: "Base network verification is unavailable. No swap was prepared." }, 503); }
  const parsed = await parseTradeSwapRequest({ ...body, taker: session.wallet }, { requireTaker: true });
  if (!parsed.ok) return reply({ code: parsed.error.code, error: parsed.error.message }, parsed.error.code === "PROVIDER_ERROR" ? 503 : 400);
  for (const token of [parsed.value.from, parsed.value.to]) {
    // Path-eligible tokens carry import-verified live decimals; registry pairs
    // keep the exact deployed-registration check.
    if (findExecutorToken(deployment, swapPoolAsset(token.address))?.decimals !== token.decimals && !pathEligible) return reply({ code: "TOKEN_METADATA_UNAVAILABLE", error: "Live token decimals do not match the approved route registration. No swap was prepared." }, 422);
  }
  const p = parsed.value;
  let search: Awaited<ReturnType<typeof searchSwapRoutes>>;
  try {
    search = await searchSwapRoutes(getTradePublicClient(), p, body.refreshQuote === true);
  } catch (error) {
    if (error instanceof SwapRouteQualificationError) return reply({ code: error.status === 503 ? "PROVIDER_ERROR" : error.reason === "LIQUIDITY_UNAVAILABLE" ? "LIQUIDITY_UNAVAILABLE" : "EXECUTION_UNAVAILABLE", reason: error.reason, error: error.message }, error.status);
    return reply({ code: "PROVIDER_ERROR", error: "Direct route comparison is unavailable. Retry; no swap was prepared." }, 503);
  }
  const { qualified, ...result } = search;
  // Revalidate even cached results. No legacy/provider-only cache can bypass it.
  if (result.proposal.agentFee?.recipient?.toLowerCase() !== deployment.feeRecipient.toLowerCase()) return reply({ code: "EXECUTION_UNAVAILABLE", reason: "FEE_RECIPIENT_CHANGED", error: "The live Executor fee recipient differs from the approved registration. Owner verification is required; no swap was prepared." }, 422);
  const invalid = swapQuotePolicyError(result.proposal);
  if (invalid) return reply({ code: "EXECUTION_UNAVAILABLE", reason: "FEE_POLICY_INVALID", error: invalid }, 422);
  if (!swapQuoteFresh(result.proposal)) return reply({ code: "QUOTE_EXPIRED", error: "The quote expired during preparation. Request a fresh quote." }, 422);
  const priceImpactBps = await estimateQuotePriceImpactBps({ quote: result.proposal, fromAddress: p.from.address, toAddress: p.to.address, fromDecimals: p.from.decimals, toDecimals: p.to.decimals });
  // Price-impact reads must not extend the quote lifetime either.
  if (!swapQuoteFresh(result.proposal)) return reply({ code: "QUOTE_EXPIRED", error: "The quote expired during preparation. Request a fresh quote." }, 422);
  try {
    await verifyQualifiedSwapBlock(getTradePublicClient(), qualified);
  } catch (error) {
    if (error instanceof SwapRouteQualificationError) return reply({ code: "QUOTE_CHANGED", reason: error.reason, error: error.message }, error.status);
    return reply({ code: "PROVIDER_ERROR", error: "The Base quote snapshot could not be reverified. Request a fresh quote." }, 503);
  }
  if (!swapQuoteFresh(result.proposal)) return reply({ code: "QUOTE_EXPIRED", error: "The quote expired during verification. Request a fresh quote." }, 422);
  return reply({ proposal: { ...result.proposal, priceImpactBps } });
}
