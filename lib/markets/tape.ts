import "server-only";

// lib/markets/tape.ts
//
// Server-side aggregator for the Base Stocks live tape.
//
// Data sources (no secrets, no invented numbers):
//   - DEX prices + real 24h change: DexScreener public API
//     (https://api.dexscreener.com/latest/dex/tokens/<addr,...>) — the
//     same provider app/api/market/mpgr already uses. Deepest Base pool
//     per token wins; USDC-quoted pools are preferred for B20 stocks so
//     `usdDex` is the same venue the Aerodrome swap path executes on.
//   - B20 reference price: the official Chainlink Coinbase equity feeds
//     (8 decimals, total return — see docs.base.org). `updatedAt` drives
//     staleness; the feed legitimately freezes off-hours/weekends, so a
//     frozen feed keeps its last value and is flagged `stale`, never
//     extrapolated.
//   - B20 pause flag: the token's own `paused()` via the existing B20 ABI.
//   - Block number: Base RPC through lib/trade/trade-public-client.
//
// Caching: single module-level snapshot, TAPE_CACHE_TTL_SECONDS (5–15s,
// default 10). A failed refresh keeps serving the last snapshot marked
// `degraded` rather than fabricating values.
//
// Every network dependency is injectable (TapeSourceDeps) so route/lib
// tests never touch the network.

import { formatUnits } from "viem";

import { B20_TOKEN_ABI, CHAINLINK_AGGREGATOR_V3_ABI } from "@/lib/trade/b20-abi";
import { getTradePublicClient } from "@/lib/trade/trade-public-client";
import {
  TAPE_STOCK_PAIRS,
  TAPE_WRAPPED_PAIRS,
  type BasePairEntry,
} from "./base-pairs";
import type { TapeSnapshot, TapeStockEntry, TapeWrappedEntry } from "./tape-types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TAPE_CACHE_TTL_MIN = 5;
const TAPE_CACHE_TTL_MAX = 15;
const TAPE_CACHE_TTL_DEFAULT = 10;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** Cache lifetime for the aggregated snapshot. Clamped to the 5–15s product window. */
export function tapeCacheTtlSeconds(): number {
  const requested = envInt("TAPE_CACHE_TTL_SECONDS", TAPE_CACHE_TTL_DEFAULT);
  return Math.min(TAPE_CACHE_TTL_MAX, Math.max(TAPE_CACHE_TTL_MIN, requested));
}

/**
 * A Coinbase equity feed freezes off-hours by design (0.5% deviation /
 * 24h heartbeat while markets are open, last close otherwise). Anything
 * older than this is surfaced as `stale` — value still shown.
 */
export function tapeFeedStaleSeconds(): number {
  return envInt("TAPE_FEED_STALE_SECONDS", 26 * 60 * 60);
}

const DEXSCREENER_TIMEOUT_MS = 9_000;
/** DexScreener accepts comma-separated token batches; keep batches small. */
const DEXSCREENER_BATCH_SIZE = 10;
const DEXSCREENER_HOST = "https://api.dexscreener.com";

export { DEXSCREENER_HOST };

// ---------------------------------------------------------------------------
// Source types + injectable deps
// ---------------------------------------------------------------------------

export interface DexScreenerPairLike {
  chainId?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
}

export interface ChainlinkRoundLike {
  /** Raw 8-decimal answer as decimal string (sign preserved). */
  answer: string;
  /** latestRoundData().updatedAt — unix seconds. */
  updatedAt: number;
}

export interface TapeSourceDeps {
  nowMs(): number;
  getBlockNumber(): Promise<number | null>;
  readFeedRound(feed: string): Promise<ChainlinkRoundLike | null>;
  readPaused(token: string): Promise<boolean | null>;
  fetchDexPairs(addresses: readonly string[]): Promise<DexScreenerPairLike[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without any network)
// ---------------------------------------------------------------------------

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseUsdString(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Picks the pool we quote for a token:
 *   1. Base chain only, and the token must be the pool's baseToken
 *      (priceUsd then refers to OUR token, not the quote side)
 *   2. among USDC-quoted pools (when any exist) prefer the deepest —
 *      for B20 stocks that is the Aerodrome Slipstream USDC pool the
 *      swap path executes against
 *   3. otherwise the deepest pool by USD liquidity
 */
export function selectTapeDexPair(
  pairs: readonly DexScreenerPairLike[],
  tokenAddress: string,
  usdcAddress: string,
): DexScreenerPairLike | null {
  const token = tokenAddress.toLowerCase();
  const usdc = usdcAddress.toLowerCase();
  const candidates = pairs.filter(
    (pair) =>
      (pair.chainId ?? "").toLowerCase() === "base" &&
      (pair.baseToken?.address ?? "").toLowerCase() === token &&
      parseUsdString(pair.priceUsd) !== null,
  );
  if (candidates.length === 0) return null;

  const liquidityOf = (pair: DexScreenerPairLike): number =>
    toFiniteNumber(pair.liquidity?.usd) ?? 0;
  const isUsdcQuoted = (pair: DexScreenerPairLike): boolean =>
    (pair.quoteToken?.address ?? "").toLowerCase() === usdc;

  const usdcPools = candidates.filter(isUsdcQuoted);
  const pool = (usdcPools.length ? usdcPools : candidates)
    .slice()
    .sort((a, b) => liquidityOf(b) - liquidityOf(a))[0];
  return pool ?? null;
}

/**
 * Premium of the DEX price over the official feed, in basis points.
 * Integer bigint math on 1e8-scaled inputs; returns null unless both
 * legs are strictly positive finite numbers.
 */
export function computePremiumBps(usdFeed: number | null, usdDex: number | null): number | null {
  if (usdFeed === null || usdDex === null) return null;
  if (!Number.isFinite(usdFeed) || !Number.isFinite(usdDex)) return null;
  if (usdFeed <= 0 || usdDex <= 0) return null;
  // Scale to 1e8 integers (both inputs are USD with far fewer than 8
  // meaningful decimals), then bps = (dex - feed) * 10_000 / feed.
  const feed = BigInt(Math.round(usdFeed * 1e8));
  const dex = BigInt(Math.round(usdDex * 1e8));
  if (feed <= 0n) return null;
  const bps = ((dex - feed) * 10_000n) / feed;
  const asNumber = Number(bps);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

/** Chainlink 8-decimal answer (decimal string) → USD number. */
export function chainlinkAnswerToUsd(answer: string, decimals = 8): number | null {
  if (typeof answer !== "string" || !answer.trim()) return null;
  let raw: bigint;
  try {
    raw = BigInt(answer.trim());
  } catch {
    return null;
  }
  // A non-positive equity price is a broken/frozen answer — refuse to
  // publish it rather than showing a negative "price".
  if (raw <= 0n) return null;
  const value = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Groups a flat pair list by baseToken address (lowercased). */
export function groupPairsByToken(
  pairs: readonly DexScreenerPairLike[],
): Map<string, DexScreenerPairLike[]> {
  const grouped = new Map<string, DexScreenerPairLike[]>();
  for (const pair of pairs) {
    const key = (pair.baseToken?.address ?? "").toLowerCase();
    if (!key) continue;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(pair);
    else grouped.set(key, [pair]);
  }
  return grouped;
}

export function tapeSourceLabel(pair: DexScreenerPairLike | null): string {
  if (!pair) return "unavailable";
  const dex = pair.dexId ? pair.dexId.charAt(0).toUpperCase() + pair.dexId.slice(1) : "DEX";
  return `DexScreener (${dex} · Base)`;
}

// ---------------------------------------------------------------------------
// Default (production) deps
// ---------------------------------------------------------------------------

function defaultDeps(): TapeSourceDeps {
  return {
    nowMs: () => Date.now(),

    async getBlockNumber() {
      try {
        const block = await getTradePublicClient().getBlockNumber();
        return Number(block);
      } catch {
        return null;
      }
    },

    async readFeedRound(feed) {
      try {
        const round = await getTradePublicClient().readContract({
          address: feed as `0x${string}`,
          abi: CHAINLINK_AGGREGATOR_V3_ABI,
          functionName: "latestRoundData",
        });
        const answer = round[1];
        const updatedAt = round[3];
        if (answer === undefined || updatedAt === undefined) return null;
        return { answer: (answer as bigint).toString(), updatedAt: Number(updatedAt) };
      } catch {
        return null;
      }
    },

    async readPaused(token) {
      try {
        const paused = await getTradePublicClient().readContract({
          address: token as `0x${string}`,
          abi: B20_TOKEN_ABI,
          functionName: "paused",
        });
        return Boolean(paused);
      } catch {
        return null;
      }
    },

    async fetchDexPairs(addresses) {
      const all: DexScreenerPairLike[] = [];
      for (let i = 0; i < addresses.length; i += DEXSCREENER_BATCH_SIZE) {
        const batch = addresses.slice(i, i + DEXSCREENER_BATCH_SIZE);
        const url = `${DEXSCREENER_HOST}/latest/dex/tokens/${batch.join(",")}`;
        try {
          const response = await fetch(url, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(DEXSCREENER_TIMEOUT_MS),
          });
          if (!response.ok) continue;
          const data = (await response.json()) as { pairs?: DexScreenerPairLike[] };
          if (Array.isArray(data.pairs)) all.push(...data.pairs);
        } catch {
          // Batch failed — those tokens come back stale, the rest still render.
        }
      }
      return all;
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

export async function buildTapeSnapshot(deps: TapeSourceDeps = defaultDeps()): Promise<TapeSnapshot> {
  const nowMs = deps.nowMs();
  const nowSeconds = Math.floor(nowMs / 1000);
  const staleAfterSeconds = tapeFeedStaleSeconds();

  const allEntries: readonly BasePairEntry[] = [...TAPE_WRAPPED_PAIRS, ...TAPE_STOCK_PAIRS];
  const usdcAddress = TAPE_WRAPPED_PAIRS.find((pair) => pair.kind === "stable")?.address ?? "";

  const [blockNumber, dexPairs, feedRounds, pausedFlags] = await Promise.all([
    deps.getBlockNumber(),
    deps.fetchDexPairs(allEntries.map((pair) => pair.address)),
    Promise.all(
      TAPE_STOCK_PAIRS.map((pair) =>
        pair.chainlinkFeed ? deps.readFeedRound(pair.chainlinkFeed) : Promise.resolve(null),
      ),
    ),
    Promise.all(TAPE_STOCK_PAIRS.map((pair) => deps.readPaused(pair.address))),
  ]);

  const grouped = groupPairsByToken(dexPairs);

  const wrapped: TapeWrappedEntry[] = TAPE_WRAPPED_PAIRS.map((pair) => {
    const best = selectTapeDexPair(grouped.get(pair.address.toLowerCase()) ?? [], pair.address, usdcAddress);
    const usd = best ? parseUsdString(best.priceUsd) : null;
    const change24h = best ? toFiniteNumber(best.priceChange?.h24) : null;
    return {
      symbol: pair.symbol,
      name: pair.name,
      address: pair.address,
      usd,
      change24h,
      source: tapeSourceLabel(best),
      stale: usd === null,
      updatedAt: usd === null ? null : nowSeconds,
    };
  });

  const stocks: TapeStockEntry[] = TAPE_STOCK_PAIRS.map((pair, index) => {
    const round = feedRounds[index] ?? null;
    const usdFeed = round ? chainlinkAnswerToUsd(round.answer) : null;
    const feedUpdatedAt = round && Number.isFinite(round.updatedAt) ? round.updatedAt : null;
    const best = selectTapeDexPair(grouped.get(pair.address.toLowerCase()) ?? [], pair.address, usdcAddress);
    const usdDex = best ? parseUsdString(best.priceUsd) : null;
    const change24h = best ? toFiniteNumber(best.priceChange?.h24) : null;

    // Feed staleness: frozen heartbeat (weekends/off-hours/corporate
    // action) or a failed read. The last value is still shown.
    const feedStale =
      usdFeed === null ||
      feedUpdatedAt === null ||
      nowSeconds - feedUpdatedAt > staleAfterSeconds;

    const sources: string[] = [];
    sources.push(usdFeed !== null ? "Chainlink Coinbase equity feed" : "Chainlink feed unavailable");
    sources.push(tapeSourceLabel(best));

    return {
      symbol: pair.symbol,
      name: pair.name,
      address: pair.address,
      usdFeed,
      usdDex,
      premiumBps: computePremiumBps(usdFeed, usdDex),
      change24h,
      source: sources.join(" + "),
      // `stale` means "no fresh source at all"; a frozen feed with a live
      // DEX price is surfaced through `feedStale` (amber dot), not this.
      stale: feedStale && usdDex === null,
      feedStale,
      paused: pausedFlags[index] ?? null,
      feedUpdatedAt,
      dexUpdatedAt: usdDex === null ? null : nowSeconds,
    };
  });

  return {
    asOf: new Date(nowMs).toISOString(),
    chainId: 8453,
    blockNumber,
    wrapped,
    stocks,
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  snapshot: TapeSnapshot;
  storedAtMs: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<TapeSnapshot> | null = null;

function snapshotHasAnyPrice(snapshot: TapeSnapshot): boolean {
  return (
    snapshot.wrapped.some((entry) => entry.usd !== null) ||
    snapshot.stocks.some((entry) => entry.usdDex !== null || entry.usdFeed !== null)
  );
}

/** Test/dev helper — drops the in-memory snapshot. */
export function resetTapeCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Returns a snapshot no older than TAPE_CACHE_TTL_SECONDS. Concurrent
 * callers share one refresh. A refresh that comes back with no prices at
 * all keeps the previous snapshot (marked `degraded`) so the tape never
 * blanks out on a transient upstream failure.
 */
export async function getTapeSnapshot(deps: TapeSourceDeps = defaultDeps()): Promise<TapeSnapshot> {
  const nowMs = deps.nowMs();
  const ttlMs = tapeCacheTtlSeconds() * 1000;
  if (cache && nowMs - cache.storedAtMs < ttlMs) {
    return cache.snapshot;
  }

  if (!inflight) {
    inflight = buildTapeSnapshot(deps)
      .then((snapshot) => {
        if (snapshotHasAnyPrice(snapshot) || !cache) {
          cache = { snapshot, storedAtMs: deps.nowMs() };
          return snapshot;
        }
        const degraded: TapeSnapshot = { ...cache.snapshot, degraded: true };
        cache = { snapshot: degraded, storedAtMs: deps.nowMs() };
        return degraded;
      })
      .catch((error: unknown) => {
        if (cache) {
          const degraded: TapeSnapshot = { ...cache.snapshot, degraded: true };
          cache = { snapshot: degraded, storedAtMs: deps.nowMs() };
          return degraded;
        }
        throw error instanceof Error ? error : new Error("Tape aggregation failed");
      })
      .finally(() => {
        inflight = null;
      });
  }

  return inflight;
}
