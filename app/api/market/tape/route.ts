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
//
// Rate limiting is intentionally omitted. This is a public, heavily
// cached read with no side effects. Previous Redis-backed limits were
// failing closed on transient Redis errors and stalling the live tape
// for ordinary users. The in-memory snapshot cache already protects
// DexScreener and Chainlink.

import { NextResponse } from "next/server";

import { getTapeSnapshot, tapeCacheTtlSeconds } from "@/lib/markets/tape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request) {
  const ttl = tapeCacheTtlSeconds();
  const cacheHeader = `public, max-age=${ttl}, stale-while-revalidate=${ttl * 3}`;

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
