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

/**
 * REAL price history for a Coinbase equity feed: the feed's own published
 * rounds, replayed newest → oldest with AggregatorV3 `getRoundData`.
 *
 * This is the authoritative source the app already uses for tokenized
 * stocks — the chart is not modelled or extrapolated, it is the rounds
 * Chainlink actually published (a round is written on the documented
 * deviation/heartbeat schedule, so the number of points varies with
 * market activity). Failures produce fewer points, never invented ones.
 */
export async function readChainlinkRoundHistory(
  feed: `0x${string}`,
  limit = 24,
): Promise<{ t: number; price: number }[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const client = getTradePublicClient();

  const latest = await readOptional(() =>
    client.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_V3_ABI,
      functionName: "latestRoundData",
    }),
  );
  if (!latest || latest[0] === undefined) return [];

  const decimals = Number(
    (await readOptional(() =>
      client.readContract({
        address: feed,
        abi: CHAINLINK_AGGREGATOR_V3_ABI,
        functionName: "decimals",
      }),
    )) ?? 8,
  );

  const latestRoundId = latest[0] as bigint;
  const roundIds: bigint[] = [];
  for (let i = 0n; i < BigInt(limit); i++) {
    const id = latestRoundId - i;
    if (id <= 0n) break;
    roundIds.push(id);
  }
  if (roundIds.length === 0) return [];

  // One RPC round trip (Multicall3); a missing/reverted round is skipped
  // rather than fabricated.
  const results = await readOptional(() =>
    client.multicall({
      contracts: roundIds.map((roundId) => ({
        address: feed,
        abi: CHAINLINK_AGGREGATOR_V3_ABI,
        functionName: "getRoundData" as const,
        args: [roundId] as const,
      })),
      allowFailure: true,
    }),
  );
  if (!results) return [];

  const points: { t: number; price: number }[] = [];
  for (const result of results) {
    if (result.status !== "success") continue;
    const answer = result.result[1] as bigint;
    const updatedAt = Number(result.result[3] as bigint);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
    if (answer <= 0n) continue;
    const price = Number(formatUnits(answer, decimals));
    if (!Number.isFinite(price) || price <= 0) continue;
    points.push({ t: updatedAt, price });
  }

  // Oldest → newest for the chart.
  return points.sort((a, b) => a.t - b.t);
}

/**
 * Lightweight, single-purpose on-chain decimals read for a B20 token.
 * Used by the swap-amount conversion path (trade-request.ts), which
 * needs only this one value and must not assume a catalog default —
 * a wrong decimals value here is a real-funds unit error. Returns
 * null if the read fails; callers must fail closed on null, not
 * fall back to a guess.
 */
export async function readB20Decimals(address: `0x${string}`): Promise<number | null> {
  const client = getTradePublicClient();
  return readOptional(async () => {
    const decimals = await client.readContract({
      address,
      abi: B20_TOKEN_ABI,
      functionName: "decimals",
    });
    const n = Number(decimals);
    if (!Number.isInteger(n) || n < 0 || n > 255) return Promise.reject(new Error("invalid decimals"));
    return n;
  });
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
