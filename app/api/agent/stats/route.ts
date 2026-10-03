import "server-only";

import { NextResponse } from "next/server";
import { parseAbiItem } from "viem";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { getRedis } from "@/lib/api/redis";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC } from "@/lib/executor/executor-config";
import { VERIFIED_HISTORICAL_AGENT_TRADES } from "@/lib/agent/agent-volume-history";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_KEY = "mpgr:agent:stats:v2";
const CACHE_TTL_SECONDS = 60;
// Keep ranges conservative for public Base RPCs. If a provider still rejects a
// range, scanRange() halves it until the request succeeds.
const INITIAL_LOG_CHUNK = 20_000n;

const SWAP_EXECUTED_EVENT = parseAbiItem(
  "event SwapExecuted(address indexed taker,address indexed router,bytes32 indexed intentId,address tokenIn,address tokenOut,uint256 grossAmountIn,uint256 feeAmount,uint256 swapAmountIn,uint256 amountOut,address feeRecipient,uint16 feeBps,uint8 routerKind,uint8 flags)",
);

type Stats = {
  available: boolean;
  totalValueTradedUsd: number | null;
  tradeCount: number | null;
};

function unavailable() {
  return NextResponse.json<Stats>(
    { available: false, totalValueTradedUsd: null, tradeCount: null },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

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

async function scanRange(
  client: ReturnType<typeof getTradePublicClient>,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): Promise<{
  totalUsdcAtomic: bigint;
  tradeCount: number;
  txHashes: Set<string>;
}> {
  let totalUsdcAtomic = 0n;
  let tradeCount = 0;
  const txHashes = new Set<string>();

  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;

    try {
      const logs = await client.getLogs({
        address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor,
        event: SWAP_EXECUTED_EVENT,
        fromBlock: start,
        toBlock: end,
      });

      for (const log of logs) {
        const { tokenIn, tokenOut, grossAmountIn, amountOut } = log.args;
        if (!tokenIn || !tokenOut || grossAmountIn === undefined || amountOut === undefined) continue;

        const inputIsUsdc = tokenIn.toLowerCase() === BASE_MAINNET_USDC.toLowerCase();
        const outputIsUsdc = tokenOut.toLowerCase() === BASE_MAINNET_USDC.toLowerCase();
        if (!inputIsUsdc && !outputIsUsdc) continue;

        // SwapExecuted is emitted only after the executor swap succeeds.
        // Use the actual USDC leg as gross executed notional.
        totalUsdcAtomic += inputIsUsdc ? grossAmountIn : amountOut;
        tradeCount += 1;
        if (log.transactionHash) txHashes.add(log.transactionHash.toLowerCase());
      }
    } catch (error) {
      // Retry the same range at half the size. This handles Base RPC
      // getLogs range/rate limits without hiding a real scan failure.
      if (chunkSize <= 250n) throw error;
      const midpoint = start + (chunkSize / 2n) - 1n;
      const firstEnd = midpoint < toBlock ? midpoint : toBlock;

      const first = await scanRange(client, start, firstEnd, chunkSize / 2n);
      const secondStart = firstEnd + 1n;
      const second =
        secondStart <= toBlock
          ? await scanRange(client, secondStart, toBlock, chunkSize / 2n)
          : { totalUsdcAtomic: 0n, tradeCount: 0, txHashes: new Set<string>() };

      totalUsdcAtomic += first.totalUsdcAtomic + second.totalUsdcAtomic;
      tradeCount += first.tradeCount + second.tradeCount;
      for (const hash of first.txHashes) txHashes.add(hash);
      for (const hash of second.txHashes) txHashes.add(hash);
      break;
    }
  }

  return { totalUsdcAtomic, tradeCount, txHashes };
}

export async function GET() {
  const cached = await readCached();
  if (cached) {
    return NextResponse.json(cached, {
      headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
    });
  }

  try {
    const client = getTradePublicClient();
    const latestBlock = await client.getBlockNumber();
    const fromBlock = BigInt(BASE_MAINNET_EXECUTOR_DEPLOYMENT.deployBlock);

    const live = await scanRange(client, fromBlock, latestBlock, INITIAL_LOG_CHUNK);

    // Merge verified pre/current historical Agent trades. Dedupe against live
    // Executor logs so a seeded Executor transaction is never counted twice.
    const liveHashes = live.txHashes;
    let totalUsdcAtomic = live.totalUsdcAtomic;
    let tradeCount = live.tradeCount;

    for (const trade of VERIFIED_HISTORICAL_AGENT_TRADES) {
      if (liveHashes.has(trade.txHash.toLowerCase())) continue;
      totalUsdcAtomic += trade.usdcAtomic;
      tradeCount += 1;
    }

    const stats: Stats = {
      available: true,
      totalValueTradedUsd: Number(totalUsdcAtomic) / 1_000_000,
      tradeCount,
    };

    await writeCached(stats);

    return NextResponse.json(stats, {
      headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
    });
  } catch {
    return unavailable();
  }
}
