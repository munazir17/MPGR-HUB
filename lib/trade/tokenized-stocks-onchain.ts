// lib/trade/tokenized-stocks-onchain.ts
//
// Read-only B20 + Chainlink research for Coinbase tokenized stocks.
//
// Base docs:
//   Token Price = Underlying Equity Market Price × Multiplier
//   Coinbase Chainlink feeds already publish that total-return value
//   (underlying price × multiplier, 8 decimals). Do NOT multiply the
//   feed by the on-chain WAD multiplier a second time.
//
// Functions that are not on the published ABI are never guessed — a
// failed optional read becomes null rather than a fabricated value.

import { formatUnits } from "viem";

import { B20_TOKEN_ABI, CHAINLINK_AGGREGATOR_V3_ABI } from "./b20-abi";
import { getTradePublicClient } from "./trade-public-client";
import type { TokenizedStockCatalogEntry, TokenizedStockOnchainState } from "./trade-types";

async function readOptional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function formatUsdFromChainlink(answer: bigint, decimals: number): string {
  const negative = answer < 0n;
  const abs = negative ? -answer : answer;
  const formatted = formatUnits(abs, decimals);
  return negative ? `-${formatted}` : formatted;
}

export async function readTokenizedStockOnchain(
  entry: TokenizedStockCatalogEntry,
): Promise<TokenizedStockOnchainState> {
  const client = getTradePublicClient();

  const [symbol, name, decimals, totalSupply, multiplier, paused, round] = await Promise.all([
    readOptional(() =>
      client.readContract({
        address: entry.address,
        abi: B20_TOKEN_ABI,
        functionName: "symbol",
      }),
    ),
    readOptional(() =>
      client.readContract({
        address: entry.address,
        abi: B20_TOKEN_ABI,
        functionName: "name",
      }),
    ),
    readOptional(() =>
      client.readContract({
        address: entry.address,
        abi: B20_TOKEN_ABI,
        functionName: "decimals",
      }),
    ),
    readOptional(() =>
      client.readContract({
        address: entry.address,
        abi: B20_TOKEN_ABI,
        functionName: "totalSupply",
      }),
    ),
    readOptional(() =>
      client.readContract({
        address: entry.address,
        abi: B20_TOKEN_ABI,
        functionName: "multiplier",
      }),
    ),
    readOptional(() =>
      client.readContract({
        address: entry.address,
        abi: B20_TOKEN_ABI,
        functionName: "paused",
      }),
    ),
    readOptional(() =>
      client.readContract({
        address: entry.chainlinkFeed,
        abi: CHAINLINK_AGGREGATOR_V3_ABI,
        functionName: "latestRoundData",
      }),
    ),
  ]);

  const feedDecimals =
    (await readOptional(() =>
      client.readContract({
        address: entry.chainlinkFeed,
        abi: CHAINLINK_AGGREGATOR_V3_ABI,
        functionName: "decimals",
      }),
    )) ?? 8;

  const chainlinkPriceUsd =
    round && round[1] !== undefined
      ? formatUsdFromChainlink(round[1], Number(feedDecimals))
      : null;
  const chainlinkUpdatedAt =
    round && round[3] !== undefined ? Number(round[3]) : null;

  const multiplierWad = multiplier ?? null;

  return {
    symbol: symbol ?? null,
    name: name ?? null,
    decimals: decimals === null || decimals === undefined ? null : Number(decimals),
    totalSupply: totalSupply !== null ? totalSupply.toString() : null,
    multiplierWad: multiplierWad !== null ? multiplierWad.toString() : null,
    multiplier:
      multiplierWad !== null ? formatUnits(multiplierWad, 18) : null,
    paused,
    chainlinkPriceUsd,
    chainlinkUpdatedAt,
    // Feed already publishes underlying × multiplier (total return).
    impliedTokenPriceUsd: chainlinkPriceUsd,
  };
}
