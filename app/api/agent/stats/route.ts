import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { parseAbiItem } from "viem";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { getRedis } from "@/lib/api/redis";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC } from "@/lib/executor/executor-config";
import { VERIFIED_HISTORICAL_AGENT_TRADES } from "@/lib/agent/agent-volume-history";

// Public "total value traded" analytics for the Agent panel.
//
// Contract (unchanged for clients): every outcome is HTTP 200. A successful
// scan returns { available: true, ... } with a public, short cache header. Any
// failure returns { available: false, totalValueTradedUsd: null, tradeCount:
// null } with Cache-Control: no-store. Failure details are NEVER returned to
// the browser; they are logged server-side as a sanitized kind + numeric HTTP
// status / RPC code only (never the error message, which viem builds from the
// full provider URL, and never any wallet or key material).
//
// Reliability rules:
//  * Only a CONFIRMED range-size limitation (provider says the block range or
//    result count is too large) shrinks the scan window. Rate limits (429),
//    authorization/plan errors (401/403), other bad requests (400 without a
//    range message), timeouts and unexpected errors are NOT retried with smaller
//    ranges — shrinking under throttling only multiplies load.
//  * Failures are negatively cached for a short, kind-specific TTL, so a
//    throttled or misconfigured provider is not re-scanned by every visitor.
//  * Concurrent cold-cache requests share one scan: an in-process single-flight
//    plus a short Redis lease across serverless instances.
//  * The whole scan runs under a deadline (SCAN_BUDGET_MS) that is well inside
//    maxDuration, and every RPC call is additionally bounded by a race timer.
//
// Timeout / cancellation limitation (audited, not worked around):
//  * The race timer stops THIS route from waiting and stops the scan loop from
//    issuing further requests. It does NOT abort the underlying viem call:
//    viem's getLogs/getBlockNumber accept no AbortSignal, and the fallback
//    transport does not forward one to its transports. Only the transport's own
//    per-attempt timeout (12 s, lib/trade/trade-public-client.ts) aborts the
//    underlying fetch, and viem's retry/fallback chain bounds how long a single
//    orphaned request can keep running. Cancelling end-to-end would require
//    changing the shared trade read client, which is out of scope here.
//  * The RPC race bound is longer than one transport attempt so that a hung
//    primary can fall through to the public fallback before this route gives up.
//
// maxDuration = 60 s is valid on every Vercel plan (Hobby allows up to 300 s
// with Fluid compute, Pro up to 800 s). The scan budget leaves headroom for
// the cache writes and the response.

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const CACHE_KEY = "mpgr:agent:stats:v2";
const NEGATIVE_KEY = "mpgr:agent:stats:unavailable:v1";
const LOCK_KEY = "mpgr:agent:stats:lock:v1";
const CACHE_TTL_SECONDS = 60;
// Lease lifetime in seconds (SET EX). Must exceed SCAN_BUDGET_MS so a live scan
// cannot outlive its lease under normal operation.
const LOCK_TTL_SECONDS = 60;
const SCAN_BUDGET_MS = 40_000;
// Per-call race bound. Deliberately LONGER than one transport attempt
// (12 s, lib/trade/trade-public-client.ts): a hung primary must be allowed to
// time out and fall through to the public fallback (a further ~12 s), so this
// bound must not fire first. Total scan time is still capped by SCAN_BUDGET_MS.
const RPC_CALL_TIMEOUT_MS = 30_000;
// Compare-and-delete: only the lease holder may release. GET and DEL run
// atomically inside Redis, so an instance whose lease already expired cannot
// delete a newer instance's lease. The token is matched in both raw and JSON
// encodings because the Upstash client may store a string either way.
const RELEASE_LEASE_SCRIPT =
  'local v = redis.call("GET", KEYS[1]); if v == ARGV[1] or v == ARGV[2] then return redis.call("DEL", KEYS[1]) end; return 0';
const INITIAL_LOG_CHUNK = 20_000n;
const MIN_LOG_CHUNK = 250n;

const SWAP_EXECUTED_EVENT = parseAbiItem(
  "event SwapExecuted(address indexed taker,address indexed router,bytes32 indexed intentId,address tokenIn,address tokenOut,uint256 grossAmountIn,uint256 feeAmount,uint256 swapAmountIn,uint256 amountOut,address feeRecipient,uint16 feeBps,uint8 routerKind,uint8 flags)",
);

type Stats = {
  available: boolean;
  totalValueTradedUsd: number | null;
  tradeCount: number | null;
};

type LogScanResult = {
  totalUsdcAtomic: bigint;
  tradeCount: number;
  txHashes: Set<string>;
};

type FailureKind =
  | "rate_limited"
  | "forbidden"
  | "bad_request"
  | "range_too_large"
  | "timeout"
  | "unexpected";

/** Negative-cache lifetime per failure kind (seconds). */
const NEGATIVE_TTL_SECONDS: Record<FailureKind, number> = {
  rate_limited: 120,
  forbidden: 300,
  bad_request: 300,
  range_too_large: 300,
  timeout: 60,
  unexpected: 60,
};

/** Our own deadline / per-call timer fired. */
class StatsTimeoutError extends Error {
  override name = "StatsTimeoutError";
}

// Provider range-size wording (eth_getLogs block-range / result-count caps).
const RANGE_RE =
  /block range|range (?:is )?too (?:large|big|wide)|too many blocks|query returned more than|more than \d+ (?:results|logs)|log response size|up to \d+ blocks/i;
// Throttling / quota wording.
const RATE_RE = /rate.?limit|too many requests|throttl|compute units?|capacity|quota/i;
// Authorization / plan wording (used only to label the failure; never to retry).
const AUTH_RE = /unauthori[sz]ed|forbidden|invalid api key|api key/i;

function unavailable(): NextResponse {
  return NextResponse.json<Stats>(
    { available: false, totalValueTradedUsd: null, tradeCount: null },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

function available(stats: Stats): NextResponse {
  return NextResponse.json(stats, {
    headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
  });
}

// --- error classification (never returns or logs messages) -------------------

interface ErrorFacts {
  name: string;
  names: string[];
  httpStatus: number | null;
  rpcCode: number | null;
  text: string;
}

/** Walks the cause chain; viem wraps transport errors (HttpRequestError, RpcRequestError). */
function errorFacts(error: unknown): ErrorFacts {
  let name = "";
  const names: string[] = [];
  let httpStatus: number | null = null;
  let rpcCode: number | null = null;
  const parts: string[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < 6 && node && typeof node === "object"; depth += 1) {
    const n = node as { name?: unknown; status?: unknown; code?: unknown; shortMessage?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    if (!name && typeof n.name === "string") name = n.name;
    if (typeof n.name === "string") names.push(n.name);
    if (httpStatus === null && typeof n.status === "number") httpStatus = n.status;
    if (rpcCode === null && typeof n.code === "number") rpcCode = n.code;
    // shortMessage excludes viem's "URL: ..." metadata; still only used for matching.
    if (typeof n.shortMessage === "string") parts.push(n.shortMessage);
    else if (typeof n.message === "string") parts.push(n.message);
    // viem puts a non-OK response's body (provider wording) into `details`.
    if (typeof n.details === "string") parts.push(n.details);
    node = n.cause;
  }
  return { name, names, httpStatus, rpcCode, text: parts.join(" | ") };
}

function classifyFailure(error: unknown): FailureKind {
  if (error instanceof StatsTimeoutError) return "timeout";
  const f = errorFacts(error);
  // A timeout anywhere in the chain wins, so a wrapped TimeoutError is never
  // mistaken for a range-size or HTTP failure.
  if (f.names.some((n) => n === "TimeoutError" || n === "AbortError" || n === "StatsTimeoutError")) {
    return "timeout";
  }
  if (f.httpStatus === 401 || f.httpStatus === 403) return "forbidden";
  if (f.httpStatus === 429) return "rate_limited";
  // Explicit throttling / auth wording wins over range wording: when in doubt, do not shrink.
  if (RATE_RE.test(f.text)) return "rate_limited";
  if (AUTH_RE.test(f.text)) return "forbidden";
  // Range-size retries are reserved for CONFIRMED range limits: a JSON-RPC error
  // envelope (no HTTP status) or an HTTP 400 carrying range wording. Any other
  // HTTP status (5xx, 413, ...) is a generic failure and never shrinks the scan.
  const rangeEligible = f.httpStatus === null || f.httpStatus === 400;
  if (rangeEligible && RANGE_RE.test(f.text)) return "range_too_large";
  if (f.rpcCode === -32005) return "rate_limited";
  if (f.httpStatus === 400 || f.httpStatus === 413 || f.httpStatus === 422) return "bad_request";
  if (f.rpcCode === -32602 || f.rpcCode === -32600) return "bad_request";
  return "unexpected";
}

/** Log line content: kind, numeric HTTP status / RPC code, and a bounded error class name. */
function logFailure(kind: FailureKind, error: unknown, startedAt: number): void {
  const f = errorFacts(error);
  const errorName = /^[A-Za-z]{1,40}$/.test(f.name) ? f.name : "unknown";
  console.warn("[agent-stats] scan unavailable", {
    kind,
    httpStatus: f.httpStatus,
    rpcCode: f.rpcCode,
    errorName,
    elapsedMs: Date.now() - startedAt,
  });
}

// --- bounded RPC calls --------------------------------------------------------

async function bounded<T>(deadline: number, call: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new StatsTimeoutError("scan budget exhausted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StatsTimeoutError("rpc call timed out")),
      Math.min(RPC_CALL_TIMEOUT_MS, remaining),
    );
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// --- cache, negative cache, lease --------------------------------------------

async function readCached(): Promise<Stats | null> {
  try {
    const cached = await getRedis().get<Stats>(CACHE_KEY);
    return cached?.available ? cached : null;
  } catch {
    return null;
  }
}

async function writeCached(stats: Stats): Promise<void> {
  try {
    await getRedis().set(CACHE_KEY, stats, { ex: CACHE_TTL_SECONDS });
  } catch {
    // Analytics caching is best-effort; never make the metric affect trading.
  }
}

async function readNegative(): Promise<boolean> {
  try {
    return (await getRedis().get<string>(NEGATIVE_KEY)) !== null;
  } catch {
    return false;
  }
}

async function writeNegative(kind: FailureKind): Promise<void> {
  try {
    await getRedis().set(NEGATIVE_KEY, kind, { ex: NEGATIVE_TTL_SECONDS[kind] });
  } catch {
    // Best-effort; the in-process single-flight still limits this instance.
  }
}

type LeaseState = "owned" | "held" | "no-redis";

async function acquireLease(token: string): Promise<LeaseState> {
  try {
    const result = await getRedis().set(LOCK_KEY, token, { nx: true, ex: LOCK_TTL_SECONDS });
    return result === "OK" ? "owned" : "held";
  } catch {
    return "no-redis";
  }
}

async function releaseLease(token: string): Promise<void> {
  try {
    await getRedis().eval(RELEASE_LEASE_SCRIPT, [LOCK_KEY], [token, JSON.stringify(token)]);
  } catch {
    // The lease expires on its own (LOCK_TTL_SECONDS).
  }
}

// --- scan ---------------------------------------------------------------------

async function scanRange(
  client: ReturnType<typeof getTradePublicClient>,
  fromBlock: bigint,
  toBlock: bigint,
  initialChunkSize: bigint,
  deadline: number,
): Promise<LogScanResult> {
  // The first request covers the full range, as before. A confirmed range-size
  // error halves the window (below); rate limits and other failures never do.
  const pending: Array<{ fromBlock: bigint; toBlock: bigint; chunkSize: bigint }> = [
    { fromBlock, toBlock, chunkSize: initialChunkSize },
  ];
  let totalUsdcAtomic = 0n;
  let tradeCount = 0;
  const txHashes = new Set<string>();

  while (pending.length > 0) {
    const range = pending.pop()!;

    try {
      const logs = await bounded(deadline, () =>
        client.getLogs({
          address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor,
          event: SWAP_EXECUTED_EVENT,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }),
      );

      for (const log of logs) {
        const { tokenIn, tokenOut, grossAmountIn, amountOut } = log.args;
        if (!tokenIn || !tokenOut || grossAmountIn === undefined || amountOut === undefined) continue;

        const inputIsUsdc = tokenIn.toLowerCase() === BASE_MAINNET_USDC.toLowerCase();
        const outputIsUsdc = tokenOut.toLowerCase() === BASE_MAINNET_USDC.toLowerCase();
        if (!inputIsUsdc && !outputIsUsdc) continue;

        totalUsdcAtomic += inputIsUsdc ? grossAmountIn : amountOut;
        tradeCount += 1;
        if (log.transactionHash) txHashes.add(log.transactionHash.toLowerCase());
      }
    } catch (error) {
      // ONLY a confirmed range-size limitation may shrink the window.
      if (classifyFailure(error) !== "range_too_large") throw error;

      const span = range.toBlock - range.fromBlock + 1n;
      if (span <= MIN_LOG_CHUNK) throw error;

      const nextChunkSize =
        range.chunkSize > MIN_LOG_CHUNK ? range.chunkSize / 2n : MIN_LOG_CHUNK;
      const midpoint = range.fromBlock + nextChunkSize - 1n;
      const firstEnd = midpoint < range.toBlock ? midpoint : range.toBlock;

      pending.push({
        fromBlock: range.fromBlock,
        toBlock: firstEnd,
        chunkSize: nextChunkSize,
      });

      const secondStart = firstEnd + 1n;
      if (secondStart <= range.toBlock) {
        pending.push({
          fromBlock: secondStart,
          toBlock: range.toBlock,
          chunkSize: nextChunkSize,
        });
      }
    }
  }

  return { totalUsdcAtomic, tradeCount, txHashes };
}

async function computeStats(deadline: number): Promise<Stats> {
  const client = getTradePublicClient();
  const latestBlock = await bounded(deadline, () => client.getBlockNumber());
  const fromBlock = BigInt(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployBlock);

  const live = await scanRange(client, fromBlock, latestBlock, INITIAL_LOG_CHUNK, deadline);

  const liveHashes = live.txHashes;
  let totalUsdcAtomic = live.totalUsdcAtomic;
  let tradeCount = live.tradeCount;

  for (const trade of VERIFIED_HISTORICAL_AGENT_TRADES) {
    if (liveHashes.has(trade.txHash.toLowerCase())) continue;
    totalUsdcAtomic += trade.usdcAtomic;
    tradeCount += 1;
  }

  return {
    available: true,
    totalValueTradedUsd: Number(totalUsdcAtomic) / 1_000_000,
    tradeCount,
  };
}

/**
 * One refresh attempt. Returns null when unavailable. Never throws.
 * `lease` is "held" when another instance is already scanning: this instance
 * then does NOT scan and reports unavailable for this request only (no
 * negative cache is written, so the next request can read the other
 * instance's positive cache).
 */
async function refresh(): Promise<Stats | null> {
  const token = randomUUID();
  const lease = await acquireLease(token);
  if (lease === "held") return null;

  const startedAt = Date.now();
  try {
    const stats = await computeStats(startedAt + SCAN_BUDGET_MS);
    await writeCached(stats);
    return stats;
  } catch (error) {
    const kind = classifyFailure(error);
    logFailure(kind, error, startedAt);
    await writeNegative(kind);
    return null;
  } finally {
    if (lease === "owned") await releaseLease(token);
  }
}

// In-process single-flight: concurrent cold-cache requests on one instance
// await the same scan instead of each starting a full one.
let inflight: Promise<Stats | null> | null = null;

export async function GET() {
  const cached = await readCached();
  if (cached) return available(cached);

  if (await readNegative()) return unavailable();

  if (!inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  const stats = await inflight;
  return stats ? available(stats) : unavailable();
}
