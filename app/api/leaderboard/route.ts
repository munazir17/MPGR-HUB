// app/api/leaderboard/route.ts
//
// Global leaderboard API — server-side source of truth backed by Redis
// (see lib/leaderboard/leaderboard-store.ts). This is what makes the
// leaderboard actually GLOBAL: every wallet reads the same Redis-backed
// ranking, instead of the page only ever knowing about the wallet
// currently connected in that browser.
//
// GET  ?wallet=0x...        -> { top: LeaderboardEntry[], me: LeaderboardEntry | null, totalRanked: number }
// POST { wallet, xp, seasonPoints } -> upserts that wallet's global standing
//
// Runs on Node (not Edge) since it uses @upstash/redis, same as the
// existing games reward routes.

import { NextResponse } from "next/server";
import { leaderboardStore } from "@/lib/leaderboard/leaderboard-store";
import { referralStore } from "@/lib/referral/referral-store";

export const runtime = "nodejs";

// Bug fix — global leaderboard showing only the requesting wallet.
//
// Root cause: this route reads a plain `Request` (not `NextRequest`),
// which sits in a gray area of Next.js's static-analysis for route
// caching. On Vercel this can result in each distinct request URL
// (e.g. /api/leaderboard?wallet=0xAAA... vs ?wallet=0xBBB...) being
// cached independently the FIRST time it's hit, then served from that
// frozen cache forever afterward — regardless of what's written to
// Redis later. That exactly reproduces "each wallet only ever sees
// itself": each wallet's own URL got cached at the moment only their
// own entry existed.
//
// `dynamic = "force-dynamic"` + `revalidate = 0` force this route to
// execute fresh on every request, and the explicit no-store header is
// a second layer in case an intermediate cache ignores the route
// segment config.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, no-cache, must-revalidate" };

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TOP_N = 50;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const walletParam = searchParams.get("wallet");

  if (walletParam && !ADDRESS_RE.test(walletParam)) {
    return NextResponse.json(
      { error: "Invalid wallet address" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const [topEntries, totalRanked] = await Promise.all([
      leaderboardStore.getTopN(TOP_N),
      leaderboardStore.getTotalRankedWallets(),
    ]);

    // Referral counts are always derived live from the referral store
    // (never trusted from client input) so nobody can inflate their
    // own referral count via the leaderboard sync call.
    const top = await Promise.all(
      topEntries.map(async (entry) => ({
        ...entry,
        referrals: await referralStore.getReferralCount(entry.wallet),
      }))
    );

    let me: (typeof top)[number] | null = null;
    if (walletParam) {
      const wallet = walletParam.toLowerCase();
      const inTop = top.find((e) => e.wallet === wallet);
      if (inTop) {
        me = inTop;
      } else {
        const standing = await leaderboardStore.getWalletStanding(wallet);
        if (standing) {
          me = {
            ...standing,
            referrals: await referralStore.getReferralCount(wallet),
          };
        }
      }
    }

    return NextResponse.json({ top, me, totalRanked }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("GET /api/leaderboard failed:", error);
    return NextResponse.json(
      { error: "Failed to load leaderboard" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

interface SyncRequestBody {
  wallet: string;
  xp: number;
  seasonPoints: number;
}

function isValidShape(value: unknown): value is SyncRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.wallet === "string" &&
    ADDRESS_RE.test(body.wallet) &&
    typeof body.xp === "number" &&
    Number.isFinite(body.xp) &&
    typeof body.seasonPoints === "number" &&
    Number.isFinite(body.seasonPoints)
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidShape(body)) {
    return NextResponse.json(
      { error: "Body must be { wallet: 0x-address, xp: number, seasonPoints: number }" },
      { status: 400 }
    );
  }

  try {
    await leaderboardStore.upsertEntry(body.wallet, body.xp, body.seasonPoints);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/leaderboard failed:", error);
    return NextResponse.json({ error: "Failed to sync leaderboard entry" }, { status: 500 });
  }
}
