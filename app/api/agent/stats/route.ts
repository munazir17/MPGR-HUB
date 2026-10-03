import "server-only";

import { NextResponse } from "next/server";
import { parseAbiItem } from "viem";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { getRedis } from "@/lib/api/redis";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC } from "@/lib/executor/executor-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_KEY = "mpgr:agent:stats:v1";
const CACHE_TTL_SECONDS = 60;
const LOG_CHUNK_SIZE = 20_000n;
const MIN_LOG_RANGE = 250n;

const SWAP_EXECUTED_EVENT = parseAbiItem(
  "event SwapExecuted(address indexed taker,address indexed router,bytes32 indexed intentId,address tokenIn,address tokenOut,uint256 grossAmountIn,uint256 feeAmount,uint256 swapAmountIn,uint256 amountOut,address feeRecipient,uint16 feeBps,uint8 routerKind,uint8 flags)",
);

type Stats = {
  available: boolean;
  totalValueTradedUsd: number | null;
  tradeCount: number | null;
};

type LogRange = {
  fromBlock: bigint;
  toBlock: bigint;
  chunkSize: bigint;
};

type LogScanResult = {
  totalUsdcAtomic: bigint;
  tradeCount: number;
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

async function scanExecutorLogs(
  client: ReturnType<typeof getTradePublicClient>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<LogScanResult> {
  const pending: LogRange[] = [
    { fromBlock, toBlock, chunkSize: LOG_CHUNK_SIZE },
  ];

  let totalUsdcAtomic = 0n;
  let tradeCount = 0;

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
        if (!tokenIn || !tokenOut || grossAmountIn === undefined || amountOut === undefined) {
          continue;
        }

        const inputIsUsdc =
          tokenIn.toLowerCase() === BASE_MAINNET_USDC.toLowerCase();
        const outputIsUsdc =
          tokenOut.toLowerCase() === BASE_MAINNET_USDC.toLowerCase();

        if (!inputIsUsdc && !outputIsUsdc) continue;

        totalUsdcAtomic += inputIsUsdc ? grossAmountIn : amountOut;
        tradeCount += 1;
      }
    } catch (error) {
      const span = range.toBlock - range.fromBlock + 1n;

      if (span <= MIN_LOG_RANGE) {
        throw error;
      }

      const nextChunk = range.chunkSize > MIN_LOG_RANGE
        ? range.chunkSize / 2n
        : MIN_LOG_RANGE;

      const midpoint = range.fromBlock + nextChunk - 1n;
      const leftEnd = midpoint < range.toBlock ? midpoint : range.toBlock;

      pending.push({
        fromBlock: range.fromBlock,
        toBlock: leftEnd,
        chunkSize: nextChunk,
      });

      const rightStart = leftEnd + 1n;
      if (rightStart <= range.toBlock) {
        pending.push({
          fromBlock: rightStart,
          toBlock: range.toBlock,
          chunkSize: nextChunk,
        });
      }
    }
  }

  return { totalUsdcAtomic, tradeCount };
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

    const { totalUsdcAtomic, tradeCount } = await scanExecutorLogs(
      client,
      fromBlock,
      latestBlock,
    );

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
