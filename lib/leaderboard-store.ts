// lib/leaderboard-store.ts
//
// SERVER-ONLY.
// Upstash Redis-backed store for the GLOBAL leaderboard.
//
// This is the single source of truth for cross-wallet ranking. It is
// intentionally separate from lib/xp-engine.ts (which stays exactly as
// it is — a fast, local, per-browser XP cache used for instant UI
// feedback). Whenever a wallet's local XP record changes, the client
// pushes a small summary here (see hooks/useXP.ts + app/api/leaderboard
// /route.ts), and every wallet reads the SAME Redis keys back — so
// wallet A can see wallet B, C, D, etc., not just itself.
//
// Same env vars as lib/reward-allocation/kv-allocation-store.ts:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   (falls back to KV_REST_API_URL / KV_REST_API_TOKEN for back-compat)

import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Redis client — reuses the same env vars already configured for the
// games reward module. No new infrastructure/dependency introduced.
// ---------------------------------------------------------------------------

const redisUrl =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;

const redisToken =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

if (!redisUrl || !redisToken) {
  throw new Error(
    "Upstash Redis environment variables are missing. Expected UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
  );
}

const kv = new Redis({
  url: redisUrl,
  token: redisToken,
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const SCORE_ZSET_KEY = "mpgrhub:leaderboard:score";

function metaKey(wallet: string) {
  return `mpgrhub:leaderboard:meta:${wallet}`;
}

// ---------------------------------------------------------------------------
// Deterministic composite score
// ---------------------------------------------------------------------------
//
// Redis sorted sets rank by a single numeric score. Ranking rules
// required: primary = XP, tie-break #1 = Season Points, tie-break #2 =
// a stable secondary value.
//
// We encode XP and Season Points into one composite score:
//   score = xp * SEASON_SCALE + min(seasonPoints, SEASON_SCALE - 1)
//
// Numeric-safety proof, concretely (not just asserted): JS/Redis doubles
// are exact integers up to Number.MAX_SAFE_INTEGER = 9,007,199,254,740,991.
// With SEASON_SCALE = 1,000,000, that ceiling is only reached once a
// single wallet's lifetime `xp` exceeds 9,007,199,254 (~9.007 billion).
// The largest single XP grant in lib/xp-engine.ts's XP_ACTIONS is 100
// (REFERRAL_SUCCESS). Even an implausible 50 XP-earning actions per day,
// every day, for 50 straight years, at the single largest grant size,
// totals 50 * 100 * 365 * 50 = 91,250,000 XP — about 1/100th of the
// safe ceiling. There is no realistic path to this overflowing.
//
// For the (extremely rare) case of two wallets tied on BOTH xp and
// seasonPoints, ZRANGE falls back to Redis's own tie-break behavior:
// per Redis's documented sorted-set semantics, members with an equal
// score are ordered lexicographically (byte-wise) by member name in
// ascending ZRANGE, and REV/ZREVRANGE returns the exact reverse of that
// full ordering — i.e. descending lexicographic for tied members, not
// merely "score reversed, ties left ascending". getTopN() below calls
// zrange(..., { rev: true }), so tied wallets come back in descending
// address order. This is standard documented Redis behavior, but is
// NOT something this patch was able to exercise against a live Redis
// instance in this environment — flagging that explicitly rather than
// claiming it was empirically verified here.

const SEASON_SCALE = 1_000_000;

function compositeScore(xp: number, seasonPoints: number): number {
  const safeXp = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
  const safeSeason =
    Number.isFinite(seasonPoints) && seasonPoints > 0
      ? Math.floor(seasonPoints)
      : 0;
  return safeXp * SEASON_SCALE + Math.min(safeSeason, SEASON_SCALE - 1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeaderboardMeta = {
  xp: number;
  seasonPoints: number;
  // The UTC month index (see lib/season-points.ts's getUTCSeasonOrdinal)
  // this entry's seasonPoints was computed for. Optional on read only
  // for backward compatibility with entries written before this field
  // existed — see parseMeta()/the stale-write guard in upsertEntry()
  // below for how a missing value is treated. Every entry WRITTEN by
  // this version of upsertEntry always includes it.
  seasonOrdinal?: number;
  updatedAt: string;
};

export type LeaderboardEntry = LeaderboardMeta & {
  wallet: string;
  rank: number;
};

function normalizeWallet(wallet: string): string {
  return wallet.toLowerCase();
}

function parseMeta(raw: unknown): LeaderboardMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const xp = Number(r.xp);
  const seasonPoints = Number(r.seasonPoints);
  if (!Number.isFinite(xp) || !Number.isFinite(seasonPoints)) return null;
  const seasonOrdinal = Number.isFinite(Number(r.seasonOrdinal)) ? Number(r.seasonOrdinal) : undefined;
  return {
    xp,
    seasonPoints,
    seasonOrdinal,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const leaderboardStore = {
  // Upsert a wallet's global standing. Called from app/api/leaderboard
  // (POST) whenever the client's local XP record changes. Idempotent —
  // safe to call repeatedly with the same/updated values, and this is
  // additive (ZADD overwrites the score for that member, no duplicate
  // entries are ever created for the same wallet).
  //
  // Race-condition fix — hooks/useXP.ts fires a sync on every XP-earning
  // action (connect, check-in, claim) without waiting for the previous
  // sync's response or cancelling it, so it's possible for two POSTs to
  // have their RESPONSES arrive out of order (a dropped packet, a slow
  // edge node, mobile network jitter). Two separate stale-write shapes
  // are possible, and both are guarded against here:
  //
  //   1. Plain xp regression — one POST for xp=100, a later one for
  //      xp=150, responses arrive out of order. xp in this app is
  //      monotonically non-decreasing per wallet by construction
  //      (lib/xp-engine.ts only ever does `record.xp += xp`, never a
  //      decrease), so "the write with the higher xp is newer" is a
  //      safe, true invariant. A write with a LOWER xp than what's
  //      already stored is always stale and is skipped.
  //
  //   2. Same-xp season rollover regression — this is the one plain xp
  //      comparison CANNOT catch. A wallet can go a while without
  //      earning new XP, so two syncs can legitimately carry the SAME
  //      xp while straddling a UTC month boundary: request A computed
  //      pre-rollover (seasonPoints=70), request B computed
  //      post-rollover (seasonPoints=0). If B's response reaches Redis
  //      first (correctly writing seasonPoints=0) and A's late response
  //      arrives after, a plain "only reject if xp is lower" guard would
  //      let A overwrite the correct 0 back to a stale 70 — a real
  //      regression, and NOT one blocked by requirement #1's guard,
  //      since xp is equal in both requests. To distinguish these two
  //      same-xp cases (a legitimate new-season write vs. a stale
  //      old-season write), every write also carries a `seasonOrdinal`
  //      — the UTC month index it was computed for (see
  //      lib/season-points.ts's getUTCSeasonOrdinal), which only
  //      increases over real time and is entirely server-derived, never
  //      client-supplied. A same-xp write is only rejected if its
  //      seasonOrdinal is LOWER than what's already stored; a same-xp
  //      write with an equal-or-higher seasonOrdinal (including a
  //      genuine rollover resetting seasonPoints to 0) is accepted.
  //
  //   A LEGACY entry written before this field existed has no
  //   `seasonOrdinal` in Redis. parseMeta() surfaces that as
  //   `undefined`, and the comparison below treats a missing value as
  //   "older than any real ordinal" — so the guard never blocks the
  //   FIRST write against a pre-migration record; it simply starts
  //   populating seasonOrdinal from that point on. No backfill/migration
  //   script is needed for this to self-heal.
  //
  // Note this is a read-then-write check, not a single atomic Redis
  // operation — there's a narrow window where two writes could still
  // race each other on the read step itself. Closing that fully would
  // mean a Lua script (or Upstash transaction) evaluated server-side,
  // which isn't introduced here since it can't be exercised against a
  // real Redis instance in this environment, and the residual window
  // is materially smaller and rarer than the failure modes this guard
  // already closes. This is the smallest change that fixes both
  // reported failure modes without adding untested infrastructure.
  async upsertEntry(
    walletInput: string,
    xp: number,
    seasonPoints: number,
    seasonOrdinal: number
  ): Promise<void> {
    const wallet = normalizeWallet(walletInput);

    const existing = await kv.get<LeaderboardMeta>(metaKey(wallet));
    const existingMeta = parseMeta(existing);

    if (existingMeta) {
      if (xp < existingMeta.xp) {
        console.error("leaderboardStore.upsertEntry: ignored stale/out-of-order write (lower xp)", {
          wallet,
          incomingXp: xp,
          storedXp: existingMeta.xp,
        });
        return;
      }
      const existingOrdinal = typeof existingMeta.seasonOrdinal === "number" ? existingMeta.seasonOrdinal : -Infinity;
      if (xp === existingMeta.xp && seasonOrdinal < existingOrdinal) {
        console.error("leaderboardStore.upsertEntry: ignored stale/out-of-order write (older season, same xp)", {
          wallet,
          xp,
          incomingSeasonOrdinal: seasonOrdinal,
          storedSeasonOrdinal: existingOrdinal,
        });
        return;
      }
    }

    const score = compositeScore(xp, seasonPoints);
    const meta: LeaderboardMeta = {
      xp: Math.max(0, Math.floor(xp) || 0),
      seasonPoints: Math.max(0, Math.floor(seasonPoints) || 0),
      seasonOrdinal,
      updatedAt: new Date().toISOString(),
    };

    await Promise.all([
      kv.zadd(SCORE_ZSET_KEY, { score, member: wallet }),
      // JSON SET — same pattern as lib/reward-allocation/kv-allocation-store.ts.
      // Avoids Upstash hset's Record<string, unknown> type mismatch.
      kv.set(metaKey(wallet), meta),
    ]);
  },

  // Top N wallets, highest score first, 1-indexed rank.
  async getTopN(n: number): Promise<LeaderboardEntry[]> {
    const members = await kv.zrange<string[]>(SCORE_ZSET_KEY, 0, n - 1, {
      rev: true,
    });

    if (!members || members.length === 0) return [];

    const metas = await Promise.all(
      members.map((wallet) => kv.get<LeaderboardMeta>(metaKey(wallet)))
    );

    return members
      .map((wallet, i) => {
        const meta = parseMeta(metas[i]);
        if (!meta) return null;
        return { wallet, rank: i + 1, ...meta };
      })
      .filter((entry): entry is LeaderboardEntry => entry !== null);
  },

  // A single wallet's global rank + stats, even if they're outside the
  // visible top list. Returns null if the wallet has no recorded entry
  // yet (e.g. hasn't earned any XP).
  async getWalletStanding(
    walletInput: string
  ): Promise<LeaderboardEntry | null> {
    const wallet = normalizeWallet(walletInput);

    const [zRank, meta] = await Promise.all([
      kv.zrevrank(SCORE_ZSET_KEY, wallet),
      kv.get<LeaderboardMeta>(metaKey(wallet)),
    ]);

    const parsedMeta = parseMeta(meta);
    if (zRank === null || zRank === undefined || !parsedMeta) return null;

    return { wallet, rank: zRank + 1, ...parsedMeta };
  },

  async getTotalRankedWallets(): Promise<number> {
    return kv.zcard(SCORE_ZSET_KEY);
  },
};
