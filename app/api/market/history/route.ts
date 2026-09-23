// app/api/market/history/route.ts
//
// GET /api/market/history?symbol=AAPLc — price history for the asset
// detail chart.
//
// Allowlist-only, exactly like /api/market/pair: the symbol must resolve
// through lib/markets/base-pairs.ts, so the chart can never be pointed at
// an arbitrary token. Two real series are available:
//
//   chainlink-feed — the official Coinbase equity feed's own published
//                    rounds (B20 tokenized stocks only). Immediate, and
//                    the authoritative source this app already uses.
//   dex-samples    — the same DexScreener price the ticker shows, one
//                    observation per fresh tape aggregation, recorded
//                    server-side. Grows while the app is used; it is
//                    never interpolated or back-filled.
//
// No invented points, no synthetic curve: when there is not enough real
// data the route says so with an empty/short series and the UI labels it.

import { NextResponse } from "next/server";

import { findBasePair } from "@/lib/markets/base-pairs";
import { getTapeSnapshot, tapeCacheTtlSeconds } from "@/lib/markets/tape";
import {
  TAPE_HISTORY_MAX_POINTS,
  TAPE_HISTORY_MIN_SPACING_SECONDS,
  readTapeSamples,
  type TapeHistorySeries,
} from "@/lib/markets/tape-history";
import { readChainlinkRoundHistory } from "@/lib/trade/tokenized-stocks-onchain";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const FEED_ROUNDS = 24;

export async function GET(request: Request) {
  const ttl = tapeCacheTtlSeconds();

  const rate = await checkRateLimit(
    `${clientIpFromRequest(request)}:market-history`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const url = new URL(request.url);
  const symbol = url.searchParams.get("symbol")?.trim() ?? "";
  const pair = symbol ? findBasePair(symbol) : null;
  if (!pair) {
    return NextResponse.json(
      {
        error: `"${symbol}" is not an official Coinbase wrapped asset, native USDC, or Coinbase Tokenized Stock (B20) on Base. This API does not guess contracts.`,
        code: "UNKNOWN_SYMBOL",
      },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Refresh the tape first: that both keeps the current price available
  // for context and records the newest DEX sample (throttled per symbol).
  const snapshot = await getTapeSnapshot().catch(() => null);
  const wrappedEntry =
    snapshot?.wrapped.find((entry) => entry.address.toLowerCase() === pair.address.toLowerCase()) ?? null;
  const stockEntry =
    snapshot?.stocks.find((entry) => entry.address.toLowerCase() === pair.address.toLowerCase()) ?? null;

  const series: TapeHistorySeries[] = [];

  if (pair.kind === "b20-stock" && pair.chainlinkFeed) {
    const rounds = await readChainlinkRoundHistory(pair.chainlinkFeed, FEED_ROUNDS);
    if (rounds.length > 0) {
      series.push({
        id: "chainlink-feed",
        label: "Chainlink equity feed rounds",
        source: "Chainlink Coinbase equity feed (official)",
        points: rounds,
      });
    }
  }

  const samples = readTapeSamples(pair.symbol, TAPE_HISTORY_MAX_POINTS);
  if (samples.length > 0) {
    series.push({
      id: "dex-samples",
      label: "Live DEX samples",
      source:
        (pair.kind === "b20-stock" ? stockEntry?.source : wrappedEntry?.source) ??
        "DexScreener (Base)",
      points: samples,
    });
  }

  const currentUsd =
    pair.kind === "b20-stock"
      ? stockEntry?.usdDex ?? stockEntry?.usdFeed ?? null
      : wrappedEntry?.usd ?? null;
  const change24h = stockEntry?.change24h ?? wrappedEntry?.change24h ?? null;
  const updatedAt = wrappedEntry?.updatedAt ?? stockEntry?.dexUpdatedAt ?? null;

  // Cold start: before two real observations exist for this asset, plot
  // the only history the trusted source actually publishes — its 24h
  // change. The endpoints are real (current price + the price 24h ago,
  // recovered from that published change); the path between them is not
  // observed, so the series is flagged `derived` and labelled in the UI.
  const hasDrawableObservation = series.some((entry) => entry.points.length >= 2);
  if (!hasDrawableObservation && currentUsd !== null && currentUsd > 0 && change24h !== null && change24h > -100) {
    const ago = currentUsd / (1 + change24h / 100);
    if (Number.isFinite(ago) && ago > 0) {
      series.push({
        id: "change24h-reference",
        label: "24h change reference",
        source: "Derived from the source's published 24h change",
        derived: true,
        points: [
          { t: (updatedAt ?? Math.floor(Date.now() / 1000)) - 86_400, price: ago },
          { t: updatedAt ?? Math.floor(Date.now() / 1000), price: currentUsd },
        ],
      });
    }
  }

  return NextResponse.json(
    {
      symbol: pair.symbol,
      name: pair.name,
      kind: pair.kind,
      address: pair.address,
      live: pair.live,
      currentUsd,
      series,
      sampleSpacingSeconds: TAPE_HISTORY_MIN_SPACING_SECONDS,
      updatedAt: snapshot?.asOf ?? null,
    },
    { status: 200, headers: { "Cache-Control": `public, max-age=${ttl}, stale-while-revalidate=${ttl * 3}` } },
  );
}
