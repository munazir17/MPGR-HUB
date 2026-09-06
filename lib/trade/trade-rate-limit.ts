// lib/trade/trade-rate-limit.ts
//
// Lightweight, best-effort per-IP rate limiting for the trade API
// routes (/api/trade/price, /api/trade/quote, /api/trade/stocks,
// /api/trade/stocks/quote). This is an in-memory limiter — it resets
// on cold start and is per-instance, not shared across Vercel
// regions/instances. That's a real limitation, not a full production
// rate limiter (that needs Vercel KV / Upstash Redis or similar
// shared store), but it stops the cheap, obvious abuse case — a
// single client hammering these endpoints — without adding a new
// paid dependency or env var. Upgrade to a shared store if usage
// grows enough for that gap to matter.

interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();

// Cap map growth across cold-start lifetime — a bounded LRU-ish
// eviction, not a correctness requirement.
const MAX_TRACKED_KEYS = 5000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * @param key Typically `${ip}:${routeName}` so different routes get
 *            independent budgets for the same caller.
 * @param limit Max requests allowed per window.
 * @param windowMs Window size in milliseconds.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
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

/** Best-effort client IP extraction behind Vercel's proxy. */
export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
