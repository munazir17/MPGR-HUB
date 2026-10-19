// Unreleased read-only V2 preview. Does not alter /api/swap/quote or any live
// executor. No transaction is returned before a sealed deployment is activated.
import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, verifyTrustedOrigin } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { discoverV2Quote, V2QuoteError, V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { RpcV2LiquiditySource } from "@/lib/swap/v2/rpc-source";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const reply = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
  const origin = verifyTrustedOrigin(request); if (origin) return origin;
  const session = await authenticateRequest(request); if (!session) return reply({ code: "AUTH_REQUIRED" }, 401);
  for (const key of [`${session.wallet.toLowerCase()}:trade-quote`, `${clientIpFromRequest(request)}:trade-quote:ip`]) {
    if (!(await checkRateLimit(key, 15, 60000)).allowed) return reply({ code: "RATE_LIMITED" }, 429);
  }
  const read = await readJsonBody(request); if (!read.ok) return read.response;
  if (!read.value || typeof read.value !== "object" || Array.isArray(read.value)) return reply({ code: "INVALID_INPUT" }, 400);
  const body = read.value as Record<string, unknown>;
  if (("requireMPGRFee" in body && body.requireMPGRFee !== true) || ("feeBps" in body && body.feeBps !== 25) || ("feeRecipient" in body && String(body.feeRecipient).toLowerCase() !== V2_FEE_RECIPIENT.toLowerCase())) return reply({ code: "FEE_POLICY_INVALID" }, 400);
  if ("chainId" in body && body.chainId !== 8453) return reply({ code: "INVALID_INPUT" }, 400);
  const parsed = await parseTradeSwapRequest({ ...body, taker: session.wallet }, { requireTaker: true });
  if (!parsed.ok) return reply({ code: parsed.error.code, error: parsed.error.message }, parsed.error.code === "PROVIDER_ERROR" ? 503 : 400);
  try {
    const client = getTradePublicClient(); if (await client.getChainId() !== 8453) return reply({ code: "PROVIDER_ERROR" }, 503);
    const block = await client.getBlock(); if (!block.hash || block.number === null) return reply({ code: "PROVIDER_ERROR" }, 503);
    const p = parsed.value;
    const q = await discoverV2Quote(new RpcV2LiquiditySource(client, block.number), p.from.address, p.to.address, BigInt(p.fromAmount));
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) return reply({ code: "QUOTE_CHANGED" }, 409);
    return reply(JSON.parse(JSON.stringify({ quote: q, blockNumber: block.number, blockHash: block.hash, preview: true, executable: false, executionSimulation: "not-run-unreleased", transaction: null }, (_, value) => typeof value === "bigint" ? value.toString() : value)));
  } catch (error) {
    if (error instanceof V2QuoteError) return reply({ code: error.code, error: error.message }, error.code === "DISCOVERY_UNAVAILABLE" ? 503 : 422);
    return reply({ code: "PROVIDER_ERROR", error: "V2 preview discovery is unavailable; no transaction prepared" }, 503);
  }
}
