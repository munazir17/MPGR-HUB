// lib/markets/tape-types.ts
//
// Wire shape of the Base Stocks live tape. Shared by the server
// aggregator (lib/markets/tape.ts), the API routes (/api/market/tape,
// /api/market/pair, /api/x402/tape) and the browser components
// (components/markets/*). Import-safe everywhere: types only, no
// `server-only`, no runtime values beyond the plain interfaces.
//
// Rules baked into this shape:
//   - on-chain values stay integer/bigint until the edge; anything the
//     browser renders as USD is already a JS number formatted server-side
//   - a missing/stale source is `null` + `stale: true`, never invented
//   - 24h change is only present when a real source reported it

export interface TapeWrappedEntry {
  symbol: string;
  name: string;
  address: string;
  /** USD price from the deepest Base DEX pool, or null when unavailable. */
  usd: number | null;
  /** 24h % change from the same DEX source, or null — never invented. */
  change24h: number | null;
  /** Human-readable source name, e.g. "DexScreener (Aerodrome · Base)". */
  source: string;
  stale: boolean;
  /** Unix seconds of the last successful price read (server clock). */
  updatedAt: number | null;
}

export interface TapeStockEntry {
  symbol: string;
  name: string;
  address: string;
  /** Chainlink Coinbase equity feed (total return, 8 decimals) → USD. */
  usdFeed: number | null;
  /** Aerodrome/DEX secondary-market price → USD. */
  usdDex: number | null;
  /** (usdDex − usdFeed) / usdFeed × 10 000, or null when either leg is missing. */
  premiumBps: number | null;
  change24h: number | null;
  source: string;
  stale: boolean;
  /**
   * True when the Chainlink feed leg is frozen/failed (weekends, market
   * close, corporate actions). The last feed value is still shown; the
   * UI renders the amber "stale" dot from this, and `stale` means
   * "no fresh source at all".
   */
  feedStale: boolean;
  /** B20 on-chain pause flag (transfers blocked) — null when the read failed. */
  paused: boolean | null;
  /** Unix seconds from the feed's latestRoundData().updatedAt. */
  feedUpdatedAt: number | null;
  /** Unix seconds of the last successful DEX price read (server clock). */
  dexUpdatedAt: number | null;
}

export interface TapeSnapshot {
  /** ISO timestamp of when this snapshot was assembled. */
  asOf: string;
  chainId: 8453;
  /** Latest Base block seen while assembling (null if the RPC read failed). */
  blockNumber: number | null;
  wrapped: TapeWrappedEntry[];
  stocks: TapeStockEntry[];
  /** True when the snapshot is a cached fallback after a failed refresh. */
  degraded?: boolean;
}

export interface TapePairDetail extends TapeSnapshot {
  /** The single pair the /api/market/pair caller asked for. */
  pair: {
    symbol: string;
    name: string;
    kind: "wrapped" | "stable" | "b20-stock";
    address: string;
    chainlinkFeed: string | null;
    official: true;
    basescanUrl: string;
    officialListUrl: string;
    notes: string | null;
  };
  wrappedEntry: TapeWrappedEntry | null;
  stockEntry: TapeStockEntry | null;
}
