// Last-resort multi-hop quote. Used only after the MPGR executor could not
// price the pair. The 0.25% fee is NOT collected: the deployed executor cannot
// settle Kyber or LI.FI calldata. The wallet signs the allowlisted router.
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { erc20Abi } from "@/lib/erc20-abi";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, verifyTrustedOrigin } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { buildTradeProposal } from "@/lib/trade/trade-proposal";
import { quotePublicRoute } from "@/lib/swap/route-desk";

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
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  if (!read.value || typeof read.value !== "object" || Array.isArray(read.value)) return reply({ code: "INVALID_INPUT", error: "Provide a swap request object." }, 400);
  const body = read.value as Record<string, unknown>;
  if ("chainId" in body && body.chainId !== 8453) return reply({ code: "INVALID_INPUT", error: "Use Base Mainnet (8453)." }, 400);
  const parsed = await parseTradeSwapRequest({ ...body, taker: session.wallet }, { requireTaker: true });
  if (!parsed.ok) return reply({ code: parsed.error.code, error: parsed.error.message }, parsed.error.code === "PROVIDER_ERROR" ? 503 : 400);
  const p = parsed.value;
  const route = await quotePublicRoute({
    tokenIn: p.from.address, tokenOut: p.to.address, amountIn: BigInt(p.fromAmount), taker: p.taker as Address, slippageBps: p.slippageBps,
  });
  if (!route) return reply({ code: "LIQUIDITY_UNAVAILABLE", error: "No public multi-hop route quoted this pair. Nothing was prepared." }, 422);
  const minOut = route.amountOut * BigInt(10_000 - p.slippageBps) / 10_000n;
  if (minOut <= 0n) return reply({ code: "INVALID_AMOUNT", error: "Quoted output is too small for the selected slippage." }, 422);
  const native = isNativeEthSentinel(p.from.address);
  let allowance: bigint | null = null;
  if (!native) {
    try {
      const read = await getTradePublicClient().readContract({
        address: p.from.address, abi: erc20Abi, functionName: "allowance", args: [p.taker as Address, route.router],
      });
      allowance = typeof read === "bigint" ? read : 0n;
    } catch {
      allowance = 0n;
    }
  }
  const needsApproval = allowance !== null && allowance < BigInt(p.fromAmount);
  const hops = route.hops.map((hop) => hop.exchange).join(" → ") || "multi-hop";
  const built = buildTradeProposal({
    from: p.from, to: p.to, taker: p.taker, slippageBps: p.slippageBps, provider: "public-router",
    quote: {
      liquidityAvailable: true,
      fromToken: p.from.address, toToken: p.to.address,
      fromAmount: p.fromAmount, toAmount: route.amountOut.toString(), minToAmount: minOut.toString(),
      issues: {
        allowance: needsApproval ? { currentAllowance: allowance!.toString(), spender: route.router } : null,
        balance: null,
        simulationIncomplete: false,
      },
      transaction: { to: route.router, data: route.data, value: route.value.toString() },
      permit2: null,
    },
  });
  if (!built.ok) return reply({ code: built.error.code, error: built.error.message }, 422);
  const proposal = built.proposal;
  proposal.providerLabel = route.venue === "kyber" ? "Kyber" : "LI.FI";
  proposal.warnings = [...proposal.warnings, `Route: ${proposal.providerLabel} · ${hops}`];
  proposal.description = `${proposal.description} Public multi-hop (${proposal.providerLabel}: ${hops}). The 0.25% MPGR fee is not collected — the deployed executor cannot settle this router.`;
  return reply({ proposal });
}
