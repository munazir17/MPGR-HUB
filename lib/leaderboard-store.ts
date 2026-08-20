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
// This keeps XP strictly dominant over Season Points while both stay
// well inside the 2^53 safe-integer range Redis/JS doubles support.
// For the (extremely rare) case of two wallets tied on BOTH xp and
// seasonPoints, ZRANGE falls back to Redis's own tie-break, which
// orders equal-score members lexicographically by member name (the
// lowercase wallet address) — a stable, deterministic secondary value,
// exactly as required.

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

export interface LeaderboardMeta {
  xp: number;
  seasonPoints: number;
  updatedAt: string;
}

export interface LeaderboardEntry extends LeaderboardMeta {
  wallet: string;
  rank: number;
}

function normalizeWallet(wallet: string): string {
  return wallet.toLowerCase();
}

function parseMeta(raw: unknown): LeaderboardMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const xp = Number(r.xp);
  const seasonPoints = Number(r.seasonPoints);
  if (!Number.isFinite(xp) || !Number.isFinite(seasonPoints)) return null;
  return {
    xp,
    seasonPoints,
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
  async upsertEntry(
    walletInput: string,
    xp: number,
    seasonPoints: number
  ): Promise<void> {
    const wallet = normalizeWallet(walletInput);
    const score = compositeScore(xp, seasonPoints);
    const meta: LeaderboardMeta = {
      xp: Math.max(0, Math.floor(xp) || 0),
      seasonPoints: Math.max(0, Math.floor(seasonPoints) || 0),
      updatedAt: new Date().toISOString(),
    };

    await Promise.all([
      kv.zadd(SCORE_ZSET_KEY, { score, member: wallet }),
      kv.hset(metaKey(wallet), meta),
    ]);
  },

  // Top N wallets, highest score first, 1-indexed rank.
  async getTopN(n: number): Promise<LeaderboardEntry[]> {
    const members = await kv.zrange<string[]>(SCORE_ZSET_KEY, 0, n - 1, {
      rev: true,
    });

    if (!members || members.length === 0) return [];

    const metas = await Promise.all(
      members.map((wallet) => kv.hgetall(metaKey(wallet)))
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
      kv.hgetall(metaKey(wallet)),
    ]);

    const parsedMeta = parseMeta(meta);
    if (zRank === null || zRank === undefined || !parsedMeta) return null;

    return { wallet, rank: zRank + 1, ...parsedMeta };
  },

  async getTotalRankedWallets(): Promise<number> {
    return kv.zcard(SCORE_ZSET_KEY);
  },
};
