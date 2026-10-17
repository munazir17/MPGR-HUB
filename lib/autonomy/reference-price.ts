import { checkAutonomyTarget } from "./chat-draft";

// Reference prices are display/draft inputs only, never swap quotes. Reject
// cached/degraded, mismatched, malformed, and explicitly stale observations.
export const REFERENCE_MAX_AGE_SECONDS = 120;
export type ReferencePriceResult =
  | { ok: true; referencePrice: string; source: "chainlink" | "dexscreener" }
  | { ok: false; code: "UNSUPPORTED_SYMBOL" | "PAIR_MISMATCH" | "MALFORMED_PRICE_RESPONSE" | "STALE_PRICE" | "PRICE_UNAVAILABLE" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function timestamp(value: unknown, now: number, maxAge: number): boolean {
  return positive(value) && value <= now + 30 && now - value <= maxAge;
}

/** Validates the actual get_pair tool projection, not model-generated data. */
export function selectReferencePrice(data: unknown, symbol: string, nowMs = Date.now()): ReferencePriceResult {
  const target = checkAutonomyTarget(symbol);
  if (!target.ok) return { ok: false, code: "UNSUPPORTED_SYMBOL" };
  if (!record(data) || !record(data.pair) || typeof data.asOf !== "string") {
    return { ok: false, code: "MALFORMED_PRICE_RESPONSE" };
  }
  const pair = data.pair;
  if (data.chainId !== 8453 || pair.symbol !== target.symbol ||
      typeof pair.address !== "string" || pair.address.toLowerCase() !== target.address!.toLowerCase() ||
      pair.live !== true || pair.official !== true) return { ok: false, code: "PAIR_MISMATCH" };
  const now = nowMs / 1000;
  if (data.degraded === true || !timestamp(Date.parse(data.asOf) / 1000, now, REFERENCE_MAX_AGE_SECONDS)) {
    return { ok: false, code: "STALE_PRICE" };
  }
  if (data.stock === undefined || data.wrapped === undefined ||
      (data.stock !== null && !record(data.stock)) || (data.wrapped !== null && !record(data.wrapped))) {
    return { ok: false, code: "MALFORMED_PRICE_RESPONSE" };
  }
  const stock = record(data.stock) ? data.stock : null;
  const wrapped = record(data.wrapped) ? data.wrapped : null;
  if (stock && wrapped) return { ok: false, code: "MALFORMED_PRICE_RESPONSE" };
  const entry = stock ?? wrapped;
  if (entry && (entry.symbol !== target.symbol || typeof entry.address !== "string" || entry.address.toLowerCase() !== target.address!.toLowerCase())) {
    return { ok: false, code: "PAIR_MISMATCH" };
  }
  if (stock && (typeof stock.stale !== "boolean" || typeof stock.feedStale !== "boolean" ||
      (stock.usdFeed !== null && (typeof stock.usdFeed !== "number" || !Number.isFinite(stock.usdFeed))) ||
      (stock.usdDex !== null && (typeof stock.usdDex !== "number" || !Number.isFinite(stock.usdDex))))) {
    return { ok: false, code: "MALFORMED_PRICE_RESPONSE" };
  }
  if (wrapped && (typeof wrapped.stale !== "boolean" || (wrapped.usd !== null && (typeof wrapped.usd !== "number" || !Number.isFinite(wrapped.usd))))) {
    return { ok: false, code: "MALFORMED_PRICE_RESPONSE" };
  }
  let raw: number | null = null;
  let source: "chainlink" | "dexscreener" = "dexscreener";
  // The server's feedStale flag uses its configured equity heartbeat window.
  // A fresh snapshot alone must not make an old feed or DEX observation fresh.
  if (stock?.stale === false) {
    if (positive(stock.usdFeed) && stock.feedStale === false && timestamp(stock.feedUpdatedAt, now, 26 * 60 * 60)) {
      raw = stock.usdFeed;
      source = "chainlink";
    } else if (positive(stock.usdDex) && timestamp(stock.dexUpdatedAt, now, REFERENCE_MAX_AGE_SECONDS)) {
      raw = stock.usdDex;
    }
  } else if (wrapped?.stale === false && positive(wrapped.usd) && timestamp(wrapped.updatedAt, now, REFERENCE_MAX_AGE_SECONDS)) {
    raw = wrapped.usd;
  }
  if (raw === null) return { ok: false, code: positive(stock?.usdFeed) || positive(stock?.usdDex) || positive(wrapped?.usd) ? "STALE_PRICE" : "PRICE_UNAVAILABLE" };
  const referencePrice = raw.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (Number(referencePrice) <= 0) return { ok: false, code: "PRICE_UNAVAILABLE" };
  return { ok: true, referencePrice, source };
}
