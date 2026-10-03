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
  initialChunkSize: bigint,
): Promise<LogScanResult> {
  const pending: Array<{ fromBlock: bigint; toBlock: bigint; chunkSize: bigint }> = [
    { fromBlock, toBlock, chunkSize: initialChunkSize },
  ];
  let totalUsdcAtomic = 0n;
  let tradeCount = 0;
  const txHashes = new Set<string>();

  while (pending.length > 0) {
    const range = pending.pop()!;

    try {
      const logs = await client.getLogs({
        address: BASE_MAINNET_EXECUTOR_DEPLOYMENT.executor,
        event: SWAP_EXECUTED_EVENT,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      });

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
