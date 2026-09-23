import "server-only";

// lib/trade/trade-price-impact.ts
//
// Price impact for a prepared swap, computed only from prices the app
// already trusts — never a modelled or assumed number.
//
// Reference mid = the tape's USD price of the sell leg / the tape's USD
// price of the buy leg (the same DexScreener / Chainlink Coinbase equity
// feed values the live ticker shows, aggregated server-side with a
// 5–15s cache, so this adds no new upstream call in practice).
//
// Execution price = quoted buy amount / sell amount.
//
// priceImpactBps = (mid − execution) / mid × 10 000, signed:
//   negative → the route is worse than mid (normal: spread + depth)
//   positive → the route is better than mid
//   null     → either leg has no live price, so nothing is reported
//
// Returned as null rather than a guess whenever a leg is missing/stale.

import { formatUnits } from "viem";

import { findBasePair } from "@/lib/markets/base-pairs";
import { getTapeSnapshot } from "@/lib/markets/tape";
import type { CdpSwapQuote } from "./trade-types";

interface LegAmounts {
  fromAmount: string;
  toAmount: string;
  fromDecimals: number;
  toDecimals: number;
}

function humanAmount(atomic: string, decimals: number): number | null {
  try {
    const value = Number(formatUnits(BigInt(atomic), decimals));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** USD price of an allowlisted asset from the current tape snapshot. */
function tapeUsdPrice(
  snapshot: Awaited<ReturnType<typeof getTapeSnapshot>> | null,
  address: string,
): number | null {
  if (!snapshot) return null;
  const target = address.toLowerCase();
  const wrapped = snapshot.wrapped.find((entry) => entry.address.toLowerCase() === target);
  if (wrapped && typeof wrapped.usd === "number" && wrapped.usd > 0) return wrapped.usd;
  const stock = snapshot.stocks.find((entry) => entry.address.toLowerCase() === target);
  if (stock) {
    const price = stock.usdDex ?? stock.usdFeed;
    if (typeof price === "number" && price > 0) return price;
  }
  return null;
}

export async function estimateSwapPriceImpactBps(input: {
  fromAddress: string;
  toAddress: string;
  amounts: LegAmounts;
}): Promise<number | null> {
  // Only allowlisted assets have a trusted reference price.
  if (!findBasePair(input.fromAddress) || !findBasePair(input.toAddress)) return null;

  const snapshot = await getTapeSnapshot().catch(() => null);
  if (!snapshot) return null;

  const fromUsd = tapeUsdPrice(snapshot, input.fromAddress);
  const toUsd = tapeUsdPrice(snapshot, input.toAddress);
  if (fromUsd === null || toUsd === null) return null;

  const fromHuman = humanAmount(input.amounts.fromAmount, input.amounts.fromDecimals);
  const toHuman = humanAmount(input.amounts.toAmount, input.amounts.toDecimals);
  if (fromHuman === null || toHuman === null) return null;

  const mid = fromUsd / toUsd;
  if (!Number.isFinite(mid) || mid <= 0) return null;

  const execution = toHuman / fromHuman;
  if (!Number.isFinite(execution) || execution <= 0) return null;

  const impactBps = ((mid - execution) / mid) * 10_000;
  if (!Number.isFinite(impactBps)) return null;
  // Clamp absurd values (a mispriced pool should read as "very bad", not
  // as a number that would overflow the UI).
  return Math.max(-100_000, Math.min(100_000, Math.round(impactBps)));
}

/** Convenience wrapper for a routed quote over the two token refs. */
export async function estimateQuotePriceImpactBps(input: {
  quote: Pick<CdpSwapQuote, "fromAmount" | "toAmount">;
  fromAddress: string;
  toAddress: string;
  fromDecimals: number;
  toDecimals: number;
}): Promise<number | null> {
  return estimateSwapPriceImpactBps({
    fromAddress: input.fromAddress,
    toAddress: input.toAddress,
    amounts: {
      fromAmount: input.quote.fromAmount,
      toAmount: input.quote.toAmount,
      fromDecimals: input.fromDecimals,
      toDecimals: input.toDecimals,
    },
  });
}
