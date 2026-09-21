// app/api/market/pair/route.ts
//
// GET /api/market/pair?symbol=AAPLc — one tape pair in detail.
//
// Allowlist-only: the symbol must resolve through lib/markets/base-pairs
// (official Coinbase wrapped assets, native USDC, or an official B20
// contract). Unknown symbols get a 404, never a guessed contract.
// The body carries the Basescan URL and the official-list URL so the
// pair sheet can tell the user where to verify before signing.

import { NextResponse } from "next/server";

import {
  basescanTokenUrl,
  findBasePair,
  OFFICIAL_LIST_SOURCES,
} from "@/lib/markets/base-pairs";
import { getTapeSnapshot, tapeCacheTtlSeconds } from "@/lib/markets/tape";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";
import type { TapePairDetail } from "@/lib/markets/tape-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  const ttl = tapeCacheTtlSeconds();
  const cacheHeader = `public, max-age=${ttl}, stale-while-revalidate=${ttl * 3}`;

  const rate = await checkRateLimit(
    `${clientIpFromRequest(request)}:market-pair`,
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

  try {
    const snapshot = await getTapeSnapshot();
    const wrappedEntry =
      pair.segment === "wrapped"
        ? snapshot.wrapped.find((entry) => entry.address.toLowerCase() === pair.address.toLowerCase()) ?? null
        : null;
    const stockEntry =
      pair.kind === "b20-stock"
        ? snapshot.stocks.find((entry) => entry.address.toLowerCase() === pair.address.toLowerCase()) ?? null
        : null;

    const detail: TapePairDetail = {
      ...snapshot,
      pair: {
        symbol: pair.symbol,
        name: pair.name,
        kind: pair.kind,
        address: pair.address,
        company: pair.company ?? null,
        chainlinkFeed: pair.chainlinkFeed ?? null,
        // Only a live official asset is reported as official/tradable.
        official: pair.live,
        status: pair.live ? "live" : "announced-not-live",
        live: pair.live,
        basescanUrl: basescanTokenUrl(pair.address),
        officialListUrl: OFFICIAL_LIST_SOURCES[0],
        notes: pair.notes ?? null,
      },
      wrappedEntry,
      stockEntry,
    };

    return NextResponse.json(detail, { status: 200, headers: { "Cache-Control": cacheHeader } });
  } catch {
    return NextResponse.json(
      { error: "Pair data is temporarily unavailable.", code: "TAPE_UNAVAILABLE" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
