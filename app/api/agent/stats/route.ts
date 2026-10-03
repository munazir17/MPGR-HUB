import "server-only";

import { NextResponse } from "next/server";
import { parseAbiItem, type Address } from "viem";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import { getRedis } from "@/lib/api/redis";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT, BASE_MAINNET_USDC } from "@/lib/executor/executor-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_KEY = "mpgr:agent:stats:v1";
const CACHE_TTL_SECONDS = 60;
const LOG_CHUNK_SIZE = 100_000n;

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

    let totalUsdcAtomic = 0n;
    let tradeCount = 0;

    // The executor was deployed recently, so bounded chunks keep public RPC
    // providers happy without changing the source of truth: successful
    // SwapExecuted events on the Base mainnet executor.
    for (let start = fromBlock; start <= latestBlock; start += LOG_CHUNK_SIZE + 1n) {
      const end = start + LOG_CHUNK_SIZE > latestBlock ? latestBlock : start + LOG_CHUNK_SIZE;

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

        // Every production executor route is USDC <-> WETH or USDC <-> B20.
        // Use the actual USDC leg, so no external price oracle is needed and
        // the metric remains an executed, on-chain notional rather than a quote.
        if (!inputIsUsdc && !outputIsUsdc) continue;

        totalUsdcAtomic += inputIsUsdc ? grossAmountIn : amountOut;
        tradeCount += 1;
      }
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
