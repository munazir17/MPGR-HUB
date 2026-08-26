// app/api/leaderboard/route.ts
//
// Global leaderboard API — server-side source of truth backed by Redis
// (see lib/leaderboard-store.ts). This is what makes the
// leaderboard actually GLOBAL: every wallet reads the same Redis-backed
// ranking, instead of the page only ever knowing about the wallet
// currently connected in that browser.
//
// GET  ?wallet=0x...        -> { top: LeaderboardEntry[], me: LeaderboardEntry | null, totalRanked: number }
// POST { wallet, xp, history } -> upserts that wallet's global standing
//
// Runs on Node (not Edge) since it uses @upstash/redis, same as the
// existing games reward routes.
//
// Root-cause fix — Season Points data integrity.
//
// This route used to accept a client-computed `seasonPoints` number and
// store it as-is. Season Points is a scoring input, so it must be
// server-authoritative — nothing here trusts a value the client itself
// computed and handed back; any `seasonPoints` field in the request
// body is simply never read.
//
// Precision on what "server-authoritative" actually means here, stated
// plainly rather than overclaimed: the server derives Season Points
// itself from `xp` + `history` via the canonical
// lib/season-points.ts calculation, so a client can no longer directly
// submit an inflated Season Points NUMBER. But `xp` and `history`
// themselves are still client-SUBMITTED — there is no server-side
// database of XP events, only what lib/xp-engine.ts keeps in that
// wallet's own browser (see that file's header comment). This patch
// closes the "submit any seasonPoints you like" hole; it does not turn
// XP/history into a server-of-record. A client that wanted to fabricate
// `history` entries outright, rather than just submitting a bare
// `seasonPoints` number, still could — closing that fully would require
// moving XP awarding to a real backend, which is a materially bigger
// change than this bug-fix pass and isn't done here.
//
// `history` is REQUIRED (not optional) in this request body. The only
// caller in this codebase is hooks/useXP.ts, updated in this same
// patch to always send it. Making it optional would reopen a version of
// the same hole this route is closing: a request with `xp: 110` and no
// history at all would, under the legacy-recovery rule in
// lib/season-points.ts, resolve to `seasonPoints: 110` — since nothing
// in that empty history contradicts treating all of it as current-
// season. Requiring the field means that shape is rejected at the
// boundary (400) instead of being silently accepted as "no history
// known".

import { NextResponse } from "next/server";
import { leaderboardStore } from "@/lib/leaderboard-store";
import { referralStore } from "@/lib/referral/referral-store";
import { calculateSeasonPoints, getUTCSeasonOrdinal, type SeasonPointsHistoryEntry } from "@/lib/season-points";

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
  history: SeasonPointsHistoryEntry[];
}

const MAX_HISTORY_ENTRIES = 2000;

function isValidShape(value: unknown): value is SyncRequestBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (typeof body.wallet !== "string" || !ADDRESS_RE.test(body.wallet)) return false;
  // xp is a lifetime total awarded in fixed positive increments (see
  // lib/xp-engine.ts's XP_ACTIONS) — it should never legitimately be
  // negative. Rejecting it here (400) rather than silently clamping
  // means a malformed/tampered sync fails loudly instead of quietly
  // writing a 0 that could mask a client-side bug.
  if (typeof body.xp !== "number" || !Number.isFinite(body.xp) || body.xp < 0) return false;
  // history must be present as an array (see the file header comment
  // for why this is required rather than optional). The elements
  // themselves are NOT individually shape-validated here — a single
  // malformed row (bad xp type, bad timestamp) is tolerated at this
  // boundary and instead excluded, per-entry, by
  // lib/season-points.ts's calculateSeasonPoints (which counts and logs
  // how many rows it had to exclude). Rejecting the entire sync because
  // of one corrupted localStorage row would mean a wallet with a single
  // bad cached entry could never sync again until manually clearing
  // browser storage — for a low-stakes local cache, "exclude the bad
  // row and keep going" is the safer default for real users, while
  // still being structurally strict about wallet/xp/history-is-an-array.
  if (!Array.isArray(body.history) || body.history.length > MAX_HISTORY_ENTRIES) return false;
  return true;
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
      {
        error: `Body must be { wallet: 0x-address, xp: number >= 0, history: {xp:number, timestamp:string}[] (max ${MAX_HISTORY_ENTRIES} entries) }`,
      },
      { status: 400 }
    );
  }

  // Server-authoritative Season Points — see the header comment above.
  // Any `seasonPoints` field the client sends (old client builds, or a
  // tampered request) is intentionally never read; it cannot reach
  // Redis under any code path here.
  const { seasonPoints, invalidEntries } = calculateSeasonPoints(body.xp, body.history);
  if (invalidEntries > 0) {
    console.error("POST /api/leaderboard: excluded malformed/future-dated history entries", {
      wallet: body.wallet,
      invalidEntries,
    });
  }

  // Identifies the UTC calendar month this write was computed for — see
  // lib/leaderboard-store.ts's upsertEntry() for why xp comparison alone
  // isn't sufficient to guard against an out-of-order write regressing
  // a wallet's entry across a season rollover.
  const seasonOrdinal = getUTCSeasonOrdinal();

  try {
    await leaderboardStore.upsertEntry(body.wallet, body.xp, seasonPoints, seasonOrdinal);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("POST /api/leaderboard failed:", error);
    return NextResponse.json({ error: "Failed to sync leaderboard entry" }, { status: 500 });
  }
}
