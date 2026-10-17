// Strict Swap surface only. No Agent API changes, aggregator fallback or signing.
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, requestIdFromRequest, verifyTrustedOrigin, withRequestId } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { buildExecutorSwapProposal } from "@/lib/trade/trade-executor-quote";
import { withTradeQuoteCache } from "@/lib/trade/trade-quote-cache";
import { estimateQuotePriceImpactBps } from "@/lib/trade/trade-price-impact";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment, findExecutorToken, findExecutorRoute } from "@/lib/executor/executor-config";
import { MPGR_EXECUTOR_ABI } from "@/lib/executor/mpgr-executor-abi";
import { swapPairIssue, swapPoolAsset, swapRouteIssue } from "@/lib/swap/swap-capability";
import { swapQuotePolicyError } from "@/lib/swap/swap-policy";
import { swapQuoteFresh } from "@/lib/swap/swap-lifecycle";

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
  // Registry-only refusal is not a claim about metadata or liquidity. Unknown
  // imports can still be validated separately; they cannot authorize a trade.
  const capability = swapRouteIssue(body.fromToken, body.toToken);
  if (capability) return reply({ code: "EXECUTION_UNAVAILABLE", reason: capability.code, error: capability.message }, 422);
  try {
    if (await getTradePublicClient().getChainId() !== 8453) return reply({ code: "UNSUPPORTED_NETWORK", error: "The quote service could not verify Base Mainnet. No swap was prepared." }, 503);
  } catch { return reply({ code: "PROVIDER_ERROR", error: "Base network verification is unavailable. Retry shortly; no swap was prepared." }, 503); }
  // A registry entry alone is not an executable permission. Verify the exact
  // assisted deployment's current token and router mappings on each request,
  // including cache hits, without changing any permissions.
  try {
    const client = getTradePublicClient();
    const from = swapPoolAsset(body.fromToken) as `0x${string}`, to = swapPoolAsset(body.toToken) as `0x${string}`;
    const route = findExecutorRoute(deployment, from, to)!;
    const [sellAllowed, buyAllowed, kind] = await Promise.all([
      client.readContract({ address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: "isTokenAllowed", args: [from] }),
      client.readContract({ address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: "isTokenAllowed", args: [to] }),
      client.readContract({ address: deployment.executor, abi: MPGR_EXECUTOR_ABI, functionName: "routerKind", args: [route.router] }),
    ]);
    if (sellAllowed !== true || buyAllowed !== true || Number(kind) !== route.kind) return reply({ code: "EXECUTION_UNAVAILABLE", reason: "EXECUTOR_PERMISSION_MISMATCH", error: "This registered route no longer matches the Executor's Base token/router permissions. Owner verification is required; no approval or swap was requested." }, 422);
  } catch { return reply({ code: "PROVIDER_ERROR", error: "Current Executor token/router permissions could not be verified on Base. Retry shortly; no swap was prepared." }, 503); }
  const parsed = await parseTradeSwapRequest({ ...body, taker: session.wallet }, { requireTaker: true });
  if (!parsed.ok) return reply({ code: parsed.error.code, error: parsed.error.message }, parsed.error.code === "PROVIDER_ERROR" ? 503 : 400);
  for (const token of [parsed.value.from, parsed.value.to]) {
    if (findExecutorToken(deployment, swapPoolAsset(token.address))?.decimals !== token.decimals) return reply({ code: "TOKEN_METADATA_UNAVAILABLE", error: "Live token decimals do not match the approved route registration. No swap was prepared." }, 422);
  }
  const p = parsed.value;
  const result = await withTradeQuoteCache(["strict-swap", session.wallet.toLowerCase(), p.from.address.toLowerCase(), p.to.address.toLowerCase(), p.fromAmount, p.from.decimals, p.to.decimals, p.slippageBps].join(":"), 6000,
    () => buildExecutorSwapProposal({ ...p, quotedAt: new Date() }), { fresh: body.refreshQuote === true });
  if (!result.ok) {
    if (!result.supported) return reply({ code: "EXECUTION_UNAVAILABLE", reason: "FEE_ROUTE_UNREGISTERED", error: "The approved Executor route is unavailable. No alternative fee-less route will be used." }, 422);
    const error = result.error;
    const message = error.code === "PROVIDER_ERROR" ? "The registered Base pool could not be quoted. Retry shortly; no approval or swap was requested."
      : error.code === "LIQUIDITY_UNAVAILABLE" ? "The registered pool returned no executable output for this amount. Try a smaller amount or retry later."
        : error.message;
    return reply({ code: error.code, error: message }, error.code === "PROVIDER_ERROR" ? 503 : 422);
  }
  // Revalidate even cached results. No legacy/provider-only cache can bypass it.
  if (result.proposal.agentFee?.recipient?.toLowerCase() !== deployment.feeRecipient.toLowerCase()) return reply({ code: "EXECUTION_UNAVAILABLE", reason: "FEE_RECIPIENT_CHANGED", error: "The live Executor fee recipient differs from the approved registration. Owner verification is required; no swap was prepared." }, 422);
  const invalid = swapQuotePolicyError(result.proposal);
  if (invalid) return reply({ code: "EXECUTION_UNAVAILABLE", reason: "FEE_POLICY_INVALID", error: invalid }, 422);
  if (!swapQuoteFresh(result.proposal)) return reply({ code: "QUOTE_EXPIRED", error: "The quote expired during preparation. Request a fresh quote." }, 422);
  const priceImpactBps = await estimateQuotePriceImpactBps({ quote: result.proposal, fromAddress: p.from.address, toAddress: p.to.address, fromDecimals: p.from.decimals, toDecimals: p.to.decimals });
  // Price-impact reads must not extend the quote lifetime either.
  if (!swapQuoteFresh(result.proposal)) return reply({ code: "QUOTE_EXPIRED", error: "The quote expired during preparation. Request a fresh quote." }, 422);
  return reply({ proposal: { ...result.proposal, priceImpactBps } });
}
