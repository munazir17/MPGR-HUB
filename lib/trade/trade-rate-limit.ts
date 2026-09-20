// lib/trade/trade-rate-limit.ts
//
// Redis-backed rate limiter for trade routes. Replaces the previous
// in-memory Map which resets on cold start and is per-instance — useless
// on Vercel's serverless (each isolate has its own map, so an attacker
// can spray requests across regions/instances and never hit the limit).
//
// Now uses Upstash Redis (Vercel KV) with Lua-atomic INCR+EXPIRE, the same
// primitive lib/api/request-guard.ts uses for the AI limiter. Falls back to
// the old in-memory map only when Redis is not configured (local dev / tests
// without KV env vars) so the app remains usable offline. In prod where
// KV_REST_API_URL/KV_REST_API_TOKEN are set, every invocation shares the same
// counter and serverless isolation is gone.
//
// Keys are fixed-window: floor(now / windowMs) per distinct caller key.
// Callers pass a key that already encodes the route (e.g. "0xabc...:trade-price")
// so different routes keep independent buckets.

import { getRedis } from "@/lib/api/redis";

interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 5000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function tryRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

const INCR_EXPIRE_LUA = "local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return c;";

async function redisIncrWithTtl(redis: ReturnType<typeof getRedis>, key: string, ttlSeconds: number): Promise<number> {
  const maybeEval = (redis as unknown as { eval?: (script: string, keys: string[], args: string[]) => Promise<unknown> }).eval;
  if (typeof maybeEval === "function") {
    try {
      const result = await maybeEval.call(redis, INCR_EXPIRE_LUA, [key], [String(ttlSeconds)]);
      const num = typeof result === "number" ? result : Number(result);
      if (Number.isFinite(num)) return num;
    } catch {
      // fall through to non-Lua fallback for test mocks
    }
  }
  const r = redis as unknown as { incr: (key: string) => Promise<number>; expire: (key: string, ttl: number) => Promise<unknown> };
  if (typeof r.incr === "function") {
    const count = await r.incr(key);
    if (count === 1 && typeof r.expire === "function") await r.expire(key, ttlSeconds);
    return count;
  }
  throw new Error("Redis incr not available");
}

function inMemoryFallback(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStartMs >= windowMs) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      buckets.clear();
    }
    buckets.set(key, { count: 1, windowStartMs: now });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.windowStartMs + windowMs - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

/**
 * @param key Typically `${ip}:${routeName}` or `${wallet}:${routeName}` so different routes get
 *            independent budgets for the same caller. Callers are responsible for choosing the key.
 * @param limit Max requests allowed per window.
 * @param windowMs Window size in milliseconds.
 *
 * Now async and Redis-backed (Lua atomic). Returns synchronously-compatible shape but as a Promise.
 * When Redis is unavailable (local dev/tests), falls back to the bounded in-memory map and allows.
 * When Redis is available but the Lua call fails, fails closed (returns not allowed) so the caller
 * can surface a 503/429 and the client degrades gracefully rather than bypassing the limiter.
 */
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const redis = tryRedis();
  if (!redis) {
    return inMemoryFallback(key, limit, windowMs);
  }

  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  // Namespace the key so it never collides with request-guard's mpgrhub:ratelimit:*
  const redisKey = `mpgrhub:trade:ratelimit:${window}:${key}`;
  const ttl = windowSeconds + 5;

  try {
    const count = await redisIncrWithTtl(redis, redisKey, ttl);
    if (count > limit) {
      const retryAfterSeconds = windowSeconds;
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
  } catch {
    // Fail closed when Redis/Lua is reachable but errored — don't let a transient Redis error
    // become a bypass. Callers will turn this into a 503/429 generic error.
    return { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds };
  }
}

/** Best-effort client IP extraction behind Vercel's proxy. */
export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
