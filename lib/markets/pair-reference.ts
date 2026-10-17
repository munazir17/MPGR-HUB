import "server-only";

import { checkAutonomyTarget } from "@/lib/autonomy/chat-draft";
import { selectReferencePrice } from "@/lib/autonomy/reference-price";
import { BASE_USDC } from "@/lib/trade/trade-config";
import { computePremiumBps, selectTapeDexPair, tapeSourceLabel, type DexScreenerPairLike } from "./tape";
import type { TapePairDetail } from "./tape-types";

/** Repair only the requested pair, not the tape, swap quotes, or any execution input.
 * The multi-token DexScreener result can omit an asset with live pools. A
 * successful batch response is not proof that every requested token was covered.
 */
export async function refreshPairReference(
  detail: TapePairDetail,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<TapePairDetail> {
  const target = checkAutonomyTarget(detail.pair.symbol);
  if (!target.ok || !detail.pair.live || detail.pair.address.toLowerCase() !== target.address!.toLowerCase()) return detail;
  const current = selectReferencePrice({ ...detail, stock: detail.stockEntry, wrapped: detail.wrappedEntry }, target.symbol!, nowMs);
  if (current.ok) return detail;
  const failure = (state: string, httpStatus?: number): TapePairDetail => ({
    ...detail,
    referenceLookup: { provider: "dexscreener", mode: "single_token", state, ...(httpStatus !== undefined ? { httpStatus } : {}) },
  });
  try {
    // Address comes exclusively from the delegated allowlist, never model output.
    const response = await fetchImpl(`https://api.dexscreener.com/latest/dex/tokens/${target.address}`, {
      headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(9_000),
    });
    if (!response.ok) return failure("http_error", response.status);
    const payload: unknown = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { pairs?: unknown }).pairs)) {
      return failure("malformed_response", response.status);
    }
    const pairs = (payload as { pairs: unknown[] }).pairs.filter((p): p is DexScreenerPairLike => {
      if (!p || typeof p !== "object" || Array.isArray(p)) return false;
      const candidate = p as DexScreenerPairLike;
      return typeof candidate.chainId === "string" && typeof candidate.baseToken?.address === "string" &&
        typeof candidate.quoteToken?.address === "string" && typeof candidate.priceUsd === "string";
    });
    const pool = selectTapeDexPair(pairs, target.address!, BASE_USDC);
    if (!pool) return failure("no_matching_price", response.status);
    const usd = Number(pool.priceUsd);
    if (!Number.isFinite(usd) || usd <= 0) return failure("invalid_price", response.status);
    const observedAt = Date.now();
    const seconds = Math.floor(observedAt / 1000);
    const source = tapeSourceLabel(pool);
    const change24h = typeof pool.priceChange?.h24 === "number" && Number.isFinite(pool.priceChange.h24) ? pool.priceChange.h24 : null;
    const refreshed: TapePairDetail = {
      ...detail,
      referenceAsOf: new Date(observedAt).toISOString(),
      referenceLookup: { provider: "dexscreener", mode: "single_token", state: "recovered", httpStatus: response.status },
    };
    if (detail.stockEntry) {
      refreshed.stockEntry = { ...detail.stockEntry, usdDex: usd, dexUpdatedAt: seconds, stale: false, feedStale: true, change24h,
        premiumBps: computePremiumBps(detail.stockEntry.usdFeed, usd),
        source: `${detail.stockEntry.usdFeed === null ? "Chainlink feed unavailable" : "Chainlink Coinbase equity feed"} + ${source}` };
    } else if (detail.wrappedEntry) {
      refreshed.wrappedEntry = { ...detail.wrappedEntry, usd, stale: false, updatedAt: seconds, source, change24h };
    } else return failure("missing_tape_entry", response.status);
    return refreshed;
  } catch {
    return failure("network_error");
  }
}
