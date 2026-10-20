// V2 quote surface. DORMANT BY DEFAULT: while `V2_DEPLOYMENT` is null this
// route is the unchanged read-only preview and returns no executable
// transaction. The activation branch below is unreachable until a separate,
// explicitly approved commit flips the gate; it never alters /api/swap/quote
// or any live V1 executor.
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, verifyTrustedOrigin } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { discoverV2Quote, V2QuoteError, V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { RpcV2LiquiditySource } from "@/lib/swap/v2/rpc-source";
import { swapV2Executor } from "@/lib/swap/v2/deployment";
import { prepareV2Execution, type V2ExecutionReader } from "@/lib/swap/v2/execution";
import { V2PreflightError } from "@/lib/swap/v2/preflight";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Same lifetime discipline as the V1 path surface: a quote is short-lived and
 * must be re-requested rather than silently reused. */
const V2_QUOTE_DEADLINE_SECONDS = 180;
const stringify = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
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
    // The pinned block hash is hashed into the intent id as bytes32, so a
    // malformed provider hash must be rejected here rather than surfacing later
    // as an opaque ABI encoding failure. Fail closed: no transaction is built.
    if (!/^0x[0-9a-fA-F]{64}$/.test(block.hash)) return reply({ code: "PROVIDER_ERROR", error: "The provider returned a malformed block hash; the quote could not be pinned." }, 503);
    const p = parsed.value;
    const q = await discoverV2Quote(new RpcV2LiquiditySource(client, block.number), p.from.address, p.to.address, BigInt(p.fromAmount));
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) return reply({ code: "QUOTE_CHANGED" }, 409);

    // ---- Activation gate. `null` = dormant: the historical preview shape. ----
    const deployment = swapV2Executor();
    if (!deployment) {
      return reply(stringify({ quote: q, blockNumber: block.number, blockHash: block.hash, preview: true, executable: false, executionSimulation: "not-run-unreleased", transaction: null }));
    }

    // ---- Activated shape (unreachable until V2_DEPLOYMENT is flipped). ----
    // A real transaction is returned only after the deployed executor simulates
    // this exact calldata at the pinned block as the real taker, and only after
    // the built calldata passes independent intent inspection.
    const nativeIn = isNativeEthSentinel(p.from.address);
    const nativeOut = isNativeEthSentinel(p.to.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + V2_QUOTE_DEADLINE_SECONDS);
    let swap;
    try {
      swap = await prepareV2Execution(client as unknown as V2ExecutionReader, deployment, {
        quote: q, taker: p.taker as Address, slippageBps: p.slippageBps, deadline, nativeIn, nativeOut,
      }, { number: block.number, hash: block.hash, timestamp: BigInt(block.timestamp) });
    } catch (error) {
      if (error instanceof V2PreflightError) return reply({ code: error.code, error: error.message }, error.status);
      if (error instanceof V2QuoteError) return reply({ code: error.code, error: error.message }, error.code === "DISCOVERY_UNAVAILABLE" ? 503 : 422);
      return reply({ code: "EXECUTION_UNAVAILABLE", error: "The V2 executor could not verify this route. No swap was prepared." }, 503);
    }
    // The block must still be the one the simulation was pinned to.
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) return reply({ code: "QUOTE_CHANGED" }, 409);
    return reply(stringify({
      quote: q, blockNumber: swap.blockNumber, blockHash: swap.blockHash,
      preview: false, executable: true, executionSimulation: swap.executionSimulation,
      transaction: { to: swap.transaction.to, data: swap.transaction.data, value: swap.transaction.value },
      executor: swap.executor, spender: swap.spender, chainId: swap.chainId,
      intentId: swap.intentId, entry: swap.entry,
      minToAmount: swap.minimum, toAmount: swap.quotedOut,
      fee: swap.fee, feeBps: swap.feeBps, feeRecipient: swap.feeRecipient,
      slippageBps: p.slippageBps, deadline: swap.intent.deadline,
      nativeIn, nativeOut, hops: swap.intent.hops,
      settlementNote: "Simulation is not a settlement proof. The receipt is verified against the committed minimum and the actual fee event after the wallet broadcasts.",
    }));
  } catch (error) {
    if (error instanceof V2QuoteError) return reply({ code: error.code, error: error.message }, error.code === "DISCOVERY_UNAVAILABLE" ? 503 : 422);
    return reply({ code: "PROVIDER_ERROR", error: "V2 preview discovery is unavailable; no transaction prepared" }, 503);
  }
}
