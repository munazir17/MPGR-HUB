// lib/markets/base-pairs.ts
//
// Typed single-source allowlist for the Base Stocks Agent live tape and
// every "is this official?" / prepare-swap decision on /agent.
//
// Per AGENTS.md rule 10 ("Keep Base chain ID, addresses, decimals, and
// ABIs in one typed configuration source") this file is import-safe from
// BOTH client components and server routes: no `server-only`, no fetches,
// no invented values.
//
// Sources verified 2026-09-21 (do not add addresses without checking
// these first — an allowlist that guesses is worse than no allowlist):
//
//   Coinbase Tokenized Stocks (B20) + Chainlink equity feeds + registry:
//     https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks
//     https://www.coinbase.com/tokenize
//   Coinbase Wrapped Assets (cbBTC/cbETH/cbDOGE/cbXRP/cbLTC/cbADA):
//     https://www.coinbase.com/campaigns/wrapped-assets
//     https://help.coinbase.com/en-gb/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/coinbase-wrapped-btc
//   Native USDC on Base (NOT "cbUSDC" — there is no such token):
//     https://docs.cdp.coinbase.com/ (USDC on Base) — same address the
//     x402/trade configs in this repo already use.
//
// The B20 stock entries are DERIVED from lib/trade/tokenized-stocks.ts's
// catalog (the pre-existing, docs-verified source used by the trade
// paths) so the tape allowlist and the swap allowlist can never drift
// apart. Ticker addresses there were re-verified against docs.base.org
// for this change and match byte-for-byte.
//
// NOTE on decimals:
//   - Wrapped/stable entries carry decimals verified on Basescan
//     (cbBTC 8, cbETH 18, cbDOGE 8, cbXRP 6, cbLTC 8, cbADA 6, USDC 6).
//     They are display/reference metadata only — the tape never does
//     on-chain amount math with them.
//   - B20 stocks intentionally carry `decimals: null`. The B20 asset
//     variant has issuer-configurable decimals and this repo's trade
//     code refuses to guess them for real-funds paths
//     (lib/trade/tokenized-stock-swap.ts). Anything that needs a B20
//     decimals value must read it on-chain, exactly like the swap path.

import type { Address } from "viem";

import { CHAIN_ID } from "@/lib/chain/base";
import {
  B20_ORACLE_REGISTRY,
  COINBASE_B20_TOKENIZED_STOCKS,
} from "@/lib/trade/tokenized-stocks";
import { BASE_USDC } from "@/lib/trade/trade-config";

export type BasePairKind = "wrapped" | "stable" | "b20-stock";

export interface BasePairEntry {
  /** Display + lookup symbol, e.g. "cbBTC", "USDC", "AAPLc". */
  symbol: string;
  /** Official product name, e.g. "Coinbase Wrapped BTC". */
  name: string;
  kind: BasePairKind;
  /** Official Base Mainnet contract address. */
  address: Address;
  /**
   * Token decimals when officially documented, or null when the value
   * must be read on-chain before any amount math (all B20 stocks).
   */
  decimals: number | null;
  chainId: 8453;
  /**
   * Official underlying-company display name for B20 stocks, exactly as
   * published on Base's verified registry (base.org/stocks) — e.g.
   * "Strategy" for MSTRc (the company renamed from MicroStrategy) and
   * "SanDisk" for SNDKc. Undefined for wrapped/stable assets.
   */
  company?: string;
  /**
   * False only for the Coinbase-published B20 addresses that Base's
   * official tokenized-stocks list marks as NOT YET LIVE (COINc, CRCLc,
   * INTCc — removed from the live list by base/docs#1955, 2026-09-11:
   * no issued supply, no Chainlink feed row, not tradable). Every other
   * entry — wrapped assets, native USDC and the 10 live stocks — is true.
   * Swap/prepare surfaces must refuse `live: false` assets.
   */
  live: boolean;
  /** Chainlink price feed proxy (Coinbase equity feeds for B20). */
  chainlinkFeed?: Address;
  /** True when this pair appears on the /agent live tape. */
  onTape: boolean;
  /** Tape segment: Coinbase wrapped/native first, then tokenized stocks. */
  segment?: "wrapped" | "stocks";
  /** Short human note shown in the pair sheet. */
  notes?: string;
}

export { B20_ORACLE_REGISTRY };

/**
 * Always-visible eligibility/disclaimer copy for the agent screen.
 * Copied from the product decision — do not soften or remove.
 */
export const BASE_STOCKS_DISCLAIMER =
  "Coinbase Tokenized Stocks are for eligible non-US persons in supported jurisdictions and represent a claim on underlying shares held in custody. Not financial advice. Always match the 0xb200 contract before you sign.";

/** Sources surfaced in the pair sheet ("verify against official list"). */
export const OFFICIAL_LIST_SOURCES = [
  // Base's own verified tokenized-stocks registry ("Match the contract
  // address before you buy. If a token is not on this list, Coinbase did
  // not issue it.").
  "https://base.org/stocks",
  "https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base",
  "https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks",
  "https://www.coinbase.com/tokenize",
  "https://www.coinbase.com/campaigns/wrapped-assets",
  // Native USDC on Base (Circle's official contract-address table).
  "https://developers.circle.com/stablecoins/usdc-contract-addresses",
] as const;

/**
 * Official underlying-company names for the B20 tokenized stocks,
 * transcribed from Base's verified registry (base.org/stocks) on
 * 2026-09-22. Note the two that differ from the older naming still used
 * by the pre-existing trade catalog: MSTRc is "Strategy" (MicroStrategy
 * renamed) and SNDKc is "SanDisk".
 */
const B20_OFFICIAL_COMPANY: Readonly<Record<string, string>> = Object.freeze({
  NVDAc: "NVIDIA",
  AAPLc: "Apple",
  GOOGLc: "Alphabet",
  METAc: "Meta",
  AMZNc: "Amazon",
  MSFTc: "Microsoft",
  TSLAc: "Tesla",
  MSTRc: "Strategy",
  SNDKc: "SanDisk",
  SPCXc: "SpaceX",
  // Coinbase has published B20 addresses for these three, but they are
  // NOT live yet (see B20_NOT_YET_LIVE).
  COINc: "Coinbase",
  CRCLc: "Circle",
  INTCc: "Intel",
});

/**
 * Coinbase-published B20 addresses that are not live yet. Base's official
 * tokenized-stocks documentation removed these three rows (and their
 * Chainlink feed rows) because listing them next to launched tokens read
 * as "tradable today" (base/docs#1955, 2026-09-11). base.org/stocks lists
 * 10 live assets. We keep the addresses so verification can answer
 * precisely — "published by Coinbase, not live, do not trade" — instead of
 * a bare "unknown", and so swaps fail closed with a real explanation.
 */
const B20_NOT_YET_LIVE: ReadonlySet<string> = new Set(["COINc", "CRCLc", "INTCc"]);

/** True when a symbol/address is a Coinbase B20 stock that is not live yet. */
export function isNotYetLiveB20(symbol: string): boolean {
  return B20_NOT_YET_LIVE.has(symbol.trim());
}

// ---------------------------------------------------------------------------
// Segment A — Coinbase wrapped assets + native USDC on Base
// ---------------------------------------------------------------------------

const WRAPPED_AND_STABLE_ENTRIES: readonly BasePairEntry[] = [
  {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    kind: "wrapped",
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    decimals: 8,
    chainId: CHAIN_ID,
    live: true,
    onTape: true,
    segment: "wrapped",
    notes: "Backed 1:1 by BTC held in Coinbase custody.",
  },
  {
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    kind: "wrapped",
    address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    decimals: 18,
    chainId: CHAIN_ID,
    live: true,
    onTape: true,
    segment: "wrapped",
    notes: "Liquid staking token for ETH staked through Coinbase.",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    kind: "stable",
    // Native USDC on Base. There is no "cbUSDC" — never render that label.
    address: BASE_USDC as Address,
    decimals: 6,
    chainId: CHAIN_ID,
    live: true,
    onTape: true,
    segment: "wrapped",
    notes: "Native USDC on Base — the quote asset for every B20 stock pool.",
  },
  // Official Coinbase-published Base addresses (coinbase.com/campaigns/
  // wrapped-assets). Included because the addresses are official, not
  // guessed. Decimals verified on Basescan.
  {
    symbol: "cbDOGE",
    name: "Coinbase Wrapped DOGE",
    kind: "wrapped",
    address: "0xcbD06E5A2B0C65597161de254AA074E489dEb510",
    decimals: 8,
    chainId: CHAIN_ID,
    live: true,
    onTape: true,
    segment: "wrapped",
    notes: "Backed 1:1 by DOGE held in Coinbase custody.",
  },
  {
    symbol: "cbXRP",
    name: "Coinbase Wrapped XRP",
    kind: "wrapped",
    address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af",
    decimals: 6,
    chainId: CHAIN_ID,
    live: true,
    onTape: true,
    segment: "wrapped",
    notes: "Backed 1:1 by XRP held in Coinbase custody.",
  },
  {
    symbol: "cbLTC",
    name: "Coinbase Wrapped LTC",
    kind: "wrapped",
    address: "0xcb17C9Db87B595717C857a08468793f5bAb6445F",
    decimals: 8,
    chainId: CHAIN_ID,
    live: true,
    onTape: true,
    segment: "wrapped",
    notes: "Backed 1:1 by LTC held in Coinbase custody.",
  },
  {
    symbol: "cbADA",
    name: "Coinbase Wrapped ADA",
    kind: "wrapped",
    address: "0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c",
    decimals: 6,
    chainId: CHAIN_ID,
    live: true,
    onTape: true,
    segment: "wrapped",
    notes: "Backed 1:1 by ADA held in Coinbase custody.",
  },
];

// ---------------------------------------------------------------------------
// Segment B — Coinbase Tokenized Stocks (B20)
// ---------------------------------------------------------------------------

/**
 * The 10 tickers the live tape shows, in tape order. The full official
 * catalog (13 entries, including COINc / CRCLc / INTCc) stays in the
 * allowlist for verification and swap routing — those three are simply
 * not tape segments per the product decision.
 */
const TAPE_STOCK_TICKERS = [
  "NVDAc",
  "AAPLc",
  "GOOGLc",
  "METAc",
  "AMZNc",
  "MSFTc",
  "TSLAc",
  "SPCXc",
  "SNDKc",
  "MSTRc",
] as const;

const tapeStockIndex = new Map<string, number>(
  TAPE_STOCK_TICKERS.map((ticker, index) => [ticker, index]),
);

const B20_ENTRIES: readonly BasePairEntry[] = COINBASE_B20_TOKENIZED_STOCKS.map(
  (stock): BasePairEntry => {
    const tapePosition = tapeStockIndex.get(stock.ticker);
    const company = B20_OFFICIAL_COMPANY[stock.ticker];
    const notYetLive = B20_NOT_YET_LIVE.has(stock.ticker);
    return {
      symbol: stock.ticker,
      // Official naming: "<Company> Tokenized Stock (Coinbase)" using the
      // company name published on base.org/stocks (so MSTRc reads
      // "Strategy", not the stale "MicroStrategy").
      name: company ? `${company} Tokenized Stock (Coinbase)` : stock.name,
      company,
      kind: "b20-stock",
      address: stock.address,
      // B20 decimals are issuer-configurable — read on-chain, never guess.
      decimals: null,
      chainId: CHAIN_ID,
      live: !notYetLive,
      // Base docs also note the on-chain metadata is mutable and that
      // tokens "should be identified by address rather than ticker or
      // symbol" — the address below is the authority, names are display.
      chainlinkFeed: notYetLive ? undefined : stock.chainlinkFeed,
      onTape: tapePosition !== undefined,
      segment: "stocks",
      notes: notYetLive
        ? "Coinbase has published this B20 address, but Base's official list marks it NOT LIVE yet (no issued supply, no Chainlink feed). Do not trade it."
        : tapePosition === undefined
          ? "Official Coinbase B20 catalog entry. Not on the default live tape."
          : "Coinbase Tokenized Stock (B20) on Base. Claim on the underlying share held in custody.",
    };
  },
).sort((a, b) => {
  const ai = tapeStockIndex.get(a.symbol) ?? Number.MAX_SAFE_INTEGER;
  const bi = tapeStockIndex.get(b.symbol) ?? Number.MAX_SAFE_INTEGER;
  return ai - bi || a.symbol.localeCompare(b.symbol);
});

// ---------------------------------------------------------------------------
// Registry + lookups
// ---------------------------------------------------------------------------

export const BASE_PAIRS: readonly BasePairEntry[] = Object.freeze([
  ...WRAPPED_AND_STABLE_ENTRIES,
  ...B20_ENTRIES,
]);

/** Tape segment A: Coinbase wrapped assets + native USDC, tape order. */
export const TAPE_WRAPPED_PAIRS: readonly BasePairEntry[] = Object.freeze(
  BASE_PAIRS.filter((pair) => pair.onTape && pair.segment === "wrapped"),
);

/** Tape segment B: Coinbase Tokenized Stocks, tape order. */
export const TAPE_STOCK_PAIRS: readonly BasePairEntry[] = Object.freeze(
  BASE_PAIRS.filter((pair) => pair.onTape && pair.segment === "stocks"),
);

const bySymbol = new Map<string, BasePairEntry>(
  BASE_PAIRS.map((pair) => [pair.symbol.toLowerCase(), pair]),
);

const byAddress = new Map<string, BasePairEntry>(
  BASE_PAIRS.map((pair) => [pair.address.toLowerCase(), pair]),
);

/** Case-insensitive symbol lookup. Also accepts a raw underlying ticker (AAPL → AAPLc). */
export function findBasePair(input: string): BasePairEntry | null {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;
  const direct = bySymbol.get(needle);
  if (direct) return direct;
  if (/^0x[a-fA-F0-9]{40}$/.test(needle)) {
    return byAddress.get(needle) ?? null;
  }
  // Underlying ticker convenience (AAPL → AAPLc), B20 only.
  const withoutSuffix = needle.endsWith("c") ? needle : `${needle}c`;
  const viaUnderlying = bySymbol.get(withoutSuffix);
  if (viaUnderlying && viaUnderlying.kind === "b20-stock") return viaUnderlying;
  return null;
}

/** Exact allowlist lookup by contract address (case-insensitive). */
export function findBasePairByAddress(address: string): BasePairEntry | null {
  const needle = address.trim().toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(needle)) return null;
  return byAddress.get(needle) ?? null;
}

export type B20VerificationStatus =
  /** On Base's verified registry (base.org/stocks) and tradable. */
  | "live"
  /** Coinbase published the address, but the asset is not live yet. */
  | "announced-not-live"
  /** Not a Coinbase B20 tokenized stock at all. */
  | "unlisted";

export interface B20Verification {
  /**
   * True only for an address that is an official Coinbase Tokenized Stock
   * AND live per base.org/stocks. Published-but-not-live addresses are
   * `official: false` with `status: "announced-not-live"` so no surface can
   * read them as tradable.
   */
  official: boolean;
  /** Precise three-state result — prefer this over `official` in UI. */
  status: B20VerificationStatus;
  /** False for not-yet-live and unlisted addresses; never trade those. */
  live: boolean;
  symbol: string | null;
  name: string | null;
  /** Official underlying-company name from base.org/stocks, when known. */
  company: string | null;
  address: string;
  chainId: 8453 | null;
  chainlinkFeed: string | null;
  registry: string | null;
  /** Where "official" comes from — never omitted when official is true. */
  source: string | null;
  reason: string;
}

const B20_VERIFICATION_SOURCE =
  "base.org/stocks verified Coinbase Tokenized Stocks registry + docs.base.org tokenized-stocks contract list (mirrored in lib/trade/tokenized-stocks.ts)";

/**
 * The only "is this contract official?" oracle in the app. Anything not
 * on the allowlist is `official: false` — including look-alike tickers
 * (bNVDA, random *c tokens) and correctly-formatted but unlisted
 * 0xb200… addresses.
 */
export function verifyB20Address(input: string): B20Verification {
  const address = input.trim();
  const pair = findBasePairByAddress(address);
  if (!pair || pair.kind !== "b20-stock") {
    return {
      official: false,
      status: "unlisted",
      live: false,
      symbol: null,
      name: null,
      company: null,
      address,
      chainId: null,
      chainlinkFeed: null,
      registry: null,
      source: null,
      reason:
        "This address is not an official Coinbase Tokenized Stock (B20) on Base. Do not swap into it. Note that a 0xb200… prefix alone does not make a token a stock — Coinbase also issues B20-standard wrapped crypto (e.g. cbHYPE, cbZEC) at 0xB200… addresses. Verify against " +
        OFFICIAL_LIST_SOURCES[0] +
        ".",
    };
  }
  if (!pair.live) {
    return {
      official: false,
      status: "announced-not-live",
      live: false,
      symbol: pair.symbol,
      name: pair.name,
      company: pair.company ?? null,
      address: pair.address,
      chainId: pair.chainId,
      chainlinkFeed: null,
      registry: B20_ORACLE_REGISTRY,
      source: B20_VERIFICATION_SOURCE,
      reason:
        `${pair.symbol} is a genuine Coinbase-published B20 address, but the asset is NOT LIVE yet: Base's official tokenized-stocks list carries 10 live assets and this one was removed pending launch (no issued supply, no Chainlink feed). ` +
        "Do not buy, sell or prepare a swap for it. Re-check " +
        OFFICIAL_LIST_SOURCES[0] +
        " for launch status.",
    };
  }
  return {
    official: true,
    status: "live",
    live: true,
    symbol: pair.symbol,
    name: pair.name,
    company: pair.company ?? null,
    address: pair.address,
    chainId: pair.chainId,
    chainlinkFeed: pair.chainlinkFeed ?? null,
    registry: B20_ORACLE_REGISTRY,
    source: B20_VERIFICATION_SOURCE,
    reason:
      "Address matches Base's official verified Coinbase Tokenized Stocks registry (base.org/stocks) and the asset is live.",
  };
}

/** Basescan token page for the pair sheet's "view on explorer" link. */
export function basescanTokenUrl(address: string): string {
  return `https://basescan.org/token/${address}`;
}
