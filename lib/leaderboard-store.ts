// lib/leaderboard/leaderboard-store.ts
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
  return safeXp * SEASON_SCALE + Math.min
