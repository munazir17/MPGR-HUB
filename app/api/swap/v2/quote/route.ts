// V2 quote surface. While `swapV2Executor()` is null this route is the
// read-only preview and returns no executable transaction. With the sealed
// manifest active, a transaction is returned only after discovery, live
// posture, pinned-block simulation and independent calldata inspection.
// This route never alters /api/swap/quote or the legacy V1 executor.
import { NextResponse } from "next/server";
import type { Address } from "viem";
import { authenticateRequest } from "@/lib/auth/session-store";
import { readJsonBody, verifyTrustedOrigin } from "@/lib/api/request-guard";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import { parseTradeSwapRequest } from "@/lib/trade/trade-request";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import { discoverV2Quote, V2QuoteError, V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { swapV2QuoteSource } from "@/lib/swap/v2/rpc-source";
import { swapV2Executor } from "@/lib/swap/v2/deployment";
import { prepareV2Execution, serializeV2Swap, type V2ExecutionReader } from "@/lib/swap/v2/execution";
import { V2PreflightError } from "@/lib/swap/v2/preflight";
import { erc20AllowanceOverride, readErc20Allowance, type AllowanceClient } from "@/lib/swap/v2/simulation-allowance";
import type { StateOverride } from "viem";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Same lifetime discipline as the V1 path surface: a quote is short-lived and
 * must be re-requested rather than silently reused. */
const V2_QUOTE_DEADLINE_SECONDS = 180;
const stringify = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

function readerWithAllowance(reader: V2ExecutionReader, stateOverride: StateOverride): V2ExecutionReader {
  return new Proxy(reader, {
    get(target, prop, receiver) {
      if (prop === "call") return (args: object) => (target.call as (args: object) => Promise<{ data: `0x${string}` | null }>)({ ...args, stateOverride });
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
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
    // Staged discovery: factory getters first. A healthy pair never scans logs.
    // A thin direct book is re-quoted through WETH or USDC, v4 included on the
    // exotic side, and the 25 bps fee stays on gross exactly once. A capped
    // search reports DISCOVERY_UNAVAILABLE rather than pretending the pool is missing.
    const q = await discoverV2Quote(swapV2QuoteSource(client, block.number), p.from.address, p.to.address, BigInt(p.fromAmount));
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) return reply({ code: "QUOTE_CHANGED" }, 409);

    // ---- Activation gate. `null` = dormant preview. The sealed manifest = executable. ----
    const deployment = swapV2Executor();
    if (!deployment) {
      return reply(stringify({ quote: q, blockNumber: block.number, blockHash: block.hash, preview: true, executable: false, executionSimulation: "not-run-unreleased", transaction: null }));
    }

    // A real transaction is returned only after the deployed executor simulates
    // this exact calldata at the pinned block as the real taker, and only after
    // the built calldata passes independent intent inspection.
    const nativeIn = isNativeEthSentinel(p.from.address);
    const nativeOut = isNativeEthSentinel(p.to.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + V2_QUOTE_DEADLINE_SECONDS);
    const baseReader = client as unknown as V2ExecutionReader;
    const allowance = nativeIn ? null : await readErc20Allowance(client as unknown as AllowanceClient, p.from.address as Address, p.taker as Address, deployment.executor, block.number);
    const needsApproval = allowance !== null && allowance < BigInt(p.fromAmount);
    const override = needsApproval ? await erc20AllowanceOverride(client as unknown as AllowanceClient, p.from.address as Address, p.taker as Address, deployment.executor, block.number) : undefined;
    const reader = override ? readerWithAllowance(baseReader, override) : baseReader;
    let swap;
    const prepare = (fundedReader: V2ExecutionReader, quoteWithoutFunding = false) => prepareV2Execution(fundedReader, deployment, {
      quote: q, taker: p.taker as Address, slippageBps: p.slippageBps, deadline, nativeIn, nativeOut,
    }, { number: block.number, hash: block.hash, timestamp: BigInt(block.timestamp) }, quoteWithoutFunding ? { quoteWithoutFunding: true } : undefined);
    try {
      swap = await prepare(reader);
    } catch (error) {
      if (error instanceof V2PreflightError) return reply({ code: error.code, error: error.message }, error.status);
      if (error instanceof V2QuoteError) return reply({ code: error.code, error: error.message }, error.code === "DISCOVERY_UNAVAILABLE" ? 503 : 422);
      if (!needsApproval) return reply({ code: "EXECUTION_UNAVAILABLE", error: "The V2 executor could not verify this route. No swap was prepared." }, 503);
      try {
        swap = await prepare(baseReader, true);
      } catch (again) {
        if (again instanceof V2PreflightError) return reply({ code: again.code, error: again.message }, again.status);
        if (again instanceof V2QuoteError) return reply({ code: again.code, error: again.message }, again.code === "DISCOVERY_UNAVAILABLE" ? 503 : 422);
        return reply({ code: "EXECUTION_UNAVAILABLE", error: "The V2 executor could not verify this route. No swap was prepared." }, 503);
      }
    }
    // The block must still be the one the simulation was pinned to.
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) return reply({ code: "QUOTE_CHANGED" }, 409);
    return reply(serializeV2Swap(swap, q, { slippageBps: p.slippageBps, nativeIn, nativeOut }));
  } catch (error) {
    if (error instanceof V2QuoteError) return reply({ code: error.code, error: error.message }, error.code === "DISCOVERY_UNAVAILABLE" ? 503 : 422);
    return reply({ code: "PROVIDER_ERROR", error: "Pricing is busy right now. Nothing was sent. Refresh the quote and try again." }, 503);
  }
}
