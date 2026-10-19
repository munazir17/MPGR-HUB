// lib/swap/route-ranking.ts
// Net-output route comparison and split-route evaluation for MPGR Swap.
// All comparisons are in OUTPUT-token atomic units after gas and MPGR fee:
//   netOut = quotedOut - gasCostNative * nativeToOutputRate / 1e18
// The MPGR fee is already excluded inside quotedOut (quotes run on G - fee).
// Nothing here proves liquidity: inputs are verified quotes from
// swap-path-quote / the aggregator client, each pinned to a block.

export interface RankedQuoteInput {
  key: string;
  label: string;
  quotedOut: bigint;
  /** Estimated execution gas units for this route (typed hops or aggregator). */
  gasEstimate: bigint;
}
export interface RankingContext {
  /** Gas price in wei per gas unit. */
  gasPriceWei: bigint;
  /** 1e18-scaled price of 1 native unit denominated in the OUTPUT token. */
  nativeToOutputRate: bigint;
}

export const RATE_SCALE = 1_000_000_000_000_000_000n;

/** Gas cost of a route expressed in output-token atomic units. */
export function gasCostInOutput(gasEstimate: bigint, ctx: RankingContext): bigint {
  // gas*gasPrice = wei; wei -> native (/1e18); native -> output atomic via the
  // 1e18-scaled rate (/1e18 again). Exact integer arithmetic throughout.
  return (gasEstimate * ctx.gasPriceWei * ctx.nativeToOutputRate) / RATE_SCALE / RATE_SCALE;
}

/** Realistic net output: quote minus gas, both in output units. */
export function netOutput(q: RankedQuoteInput, ctx: RankingContext): bigint {
  const net = q.quotedOut - gasCostInOutput(q.gasEstimate, ctx);
  return net > 0n ? net : 0n;
}

export function rankByNetOutput(quotes: readonly RankedQuoteInput[], ctx: RankingContext): { input: RankedQuoteInput; net: bigint }[] {
  return quotes
    .map(input => ({ input, net: netOutput(input, ctx) }))
    .sort((x, y) => (y.net > x.net ? 1 : y.net < x.net ? -1 : 0));
}

export interface SplitLeg extends RankedQuoteInput { shareBps: number }

/** A split is adopted only when its combined net output beats the best single
 *  route by more than the extra gas it costs (extraGasUnits) — otherwise the
 *  simpler route wins and no split is shown to the user. */
export function splitBeatsSingle(
  legs: readonly SplitLeg[],
  bestSingleNet: bigint,
  extraGasUnits: bigint,
  ctx: RankingContext,
): { adopted: boolean; splitNet: bigint; edge: bigint } {
  const splitNet = legs.reduce((acc, leg) => acc + netOutput(leg, ctx), 0n);
  const extraCost = gasCostInOutput(extraGasUnits, ctx);
  const edge = splitNet - extraCost - bestSingleNet;
  return { adopted: edge > 0n, splitNet: splitNet - extraCost, edge };
}

/** Standard split proposals evaluated when at least two distinct venues quote. */
export const SPLIT_PROPOSALS: readonly (readonly number[])[] = [[6000, 4000], [5000, 5000]] as const;

/** Builds split-leg quote requests (gross amounts per share) for a pair of
 *  single-hop candidates; the caller quotes each leg at its reduced gross. */
export function splitLegGross(gross: bigint, proposal: readonly number[]): bigint[] {
  const first = (gross * BigInt(proposal[0])) / 10000n;
  return [first, gross - first];
}
