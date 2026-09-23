import "server-only";

// lib/markets/tape-history.ts
//
// Server-side price history for the asset detail chart.
//
// What this is: every time the tape aggregator successfully assembles a
// fresh snapshot it records ONE sample per asset — the same DexScreener
// price (and, for B20 stocks, the same Chainlink feed value) the ticker
// already shows, with the server clock. Over a session those samples
// form a real, source-attributed series. Nothing is interpolated,
// back-filled, or modelled: a two-point chart is two observations, not a
// drawn shape.
//
// Tokenized stocks additionally get REAL history from the official
// Chainlink equity feed itself (round history, see
// lib/trade/tokenized-stocks-onchain.ts) — that is the authoritative
// source the rest of the app already uses for those assets, so their
// chart is populated immediately instead of waiting for samples to
// accumulate.
//
// Storage is a bounded in-memory ring per symbol. It is per server
// instance and deliberately NOT persisted: the chart never claims to be
// a permanent market archive.

export interface TapeHistoryPoint {
  /** Unix seconds. */
  t: number;
  price: number;
}

export interface TapeHistorySeries {
  id: "chainlink-feed" | "dex-samples" | "change24h-reference";
  label: string;
  source: string;
  points: TapeHistoryPoint[];
  /**
   * True only for the two-point 24h reference series built from the
   * source's own published 24h change (the endpoints are real, the path
   * between them is not observed). Rendered with an explicit label.
   */
  derived?: boolean;
}

/** Max points kept per symbol. */
export const TAPE_HISTORY_CAPACITY = 240;
/** One sample at most this often per symbol. */
export const TAPE_HISTORY_MIN_SPACING_SECONDS = 10;
/** Points returned to the browser per series. */
export const TAPE_HISTORY_MAX_POINTS = 120;

const samples = new Map<string, TapeHistoryPoint[]>();

function keyOf(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isUsable(price: number | null | undefined): price is number {
  return typeof price === "number" && Number.isFinite(price) && price > 0;
}

/**
 * Records one observed price. Ignores null/zero/non-finite values (an
 * unavailable price is never plotted as 0), throttles to one sample per
 * MIN_SPACING window, and keeps the newest CAPACITY points.
 */
export function recordTapeSample(
  symbol: string,
  price: number | null | undefined,
  atSeconds: number,
): void {
  if (!isUsable(price) || !Number.isFinite(atSeconds)) return;
  const key = keyOf(symbol);
  if (!key) return;
  const existing = samples.get(key) ?? [];
  const last = existing[existing.length - 1];
  if (last && atSeconds - last.t < TAPE_HISTORY_MIN_SPACING_SECONDS) return;
  const next = [...existing, { t: atSeconds, price }];
  if (next.length > TAPE_HISTORY_CAPACITY) {
    next.splice(0, next.length - TAPE_HISTORY_CAPACITY);
  }
  samples.set(key, next);
}

/** Recorded observations for one symbol, oldest → newest. */
export function readTapeSamples(symbol: string, limit = TAPE_HISTORY_MAX_POINTS): TapeHistoryPoint[] {
  const all = samples.get(keyOf(symbol)) ?? [];
  return all.length <= limit ? [...all] : all.slice(all.length - limit);
}

/** Symbols with at least one recorded observation (for tests/debug). */
export function tapeHistorySymbols(): string[] {
  return [...samples.keys()];
}

/** Test/dev helper — drops every recorded sample. */
export function resetTapeHistory(): void {
  samples.clear();
}
