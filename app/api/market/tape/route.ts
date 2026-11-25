// app/api/market/tape/route.ts
//
// GET /api/market/tape — the Base Stocks live tape.
//
// Server-aggregated (lib/markets/tape.ts), cached 5–15s, unauthenticated
// read. No secrets, no wallet data, no invented prices: every entry
// carries its source name and a `stale` flag instead.
//
// This is the free endpoint. The x402-gated snapshot lives at
// GET /api/x402/tape and returns this exact body plus { paid: true }.

import { NextResponse } from "next/server";

import { getTapeSnapshot, tapeCacheTtlSeconds } from "@/lib/markets/tape";
import { checkRateLimit, clientIpFromRequest } from "@/lib/trade/trade-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only market data with server-side cache. High limit so ordinary
// client polling + multiple tabs never stalls the tape. Redis failures
// fail open for this public endpoint (see check below).
const RATE_LIMIT = 2000;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  const ttl = tapeCacheTtlSeconds();
  const cacheHeader = `public, max-age=${ttl}, stale-while-revalidate=${ttl * 3}`;

  try {
    const rate = await checkRateLimit(
      `${clientIpFromRequest(request)}:market-tape`,
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
  } catch {
    // Fail open for this public cached endpoint if the rate limiter itself errors.
    // The snapshot is already heavily cached and has no secrets.
  }

  try {
    const snapshot = await getTapeSnapshot();
    return NextResponse.json(snapshot, {
      status: 200,
      headers: { "Cache-Control": cacheHeader },
    });
  } catch {
    // Never leak provider/RPC/stack details (AGENTS.md rule 8).
    return NextResponse.json(
      { error: "Live tape is temporarily unavailable.", code: "TAPE_UNAVAILABLE" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
