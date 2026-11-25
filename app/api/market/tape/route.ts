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

// Read-only market data, but still an upstream-fetch amplifier — keep a
// per-IP budget like the other trade research routes.
// Raised from 60 to 300/min so normal client polling (15s) + multiple tabs
// + occasional retries do not stall the live tape under ordinary traffic.
const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  const ttl = tapeCacheTtlSeconds();
  const cacheHeader = `public, max-age=${ttl}, stale-while-revalidate=${ttl * 3}`;

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
