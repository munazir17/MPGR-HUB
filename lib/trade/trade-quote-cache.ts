import "server-only";

// lib/trade/trade-quote-cache.ts
//
// Very short-lived, wallet-scoped dedupe for swap quotes.
//
// Why: the same swap can now be requested twice inside a second — once by
// the tape's one-tap "Prepare swap" fast path (client → /api/trade/quote)
// and once by the agent's prepare tool for the same pair — and a user can
// double-tap a chip. Those are the same question, so they should cost one
// upstream quote instead of two (the quote routes are rate-limited to 15
// requests/minute per wallet and per IP).
//
// Safety properties:
//   - entries expire after a few seconds, far inside
//     TRADE_QUOTE_MAX_AGE_MS (30s), so a served quote is still fresh
//   - the key is scoped to the authenticated session wallet by callers
//   - only a successful value is cached; failures are never reused
//   - it caches a QUOTE, never a signature, transaction broadcast, or
//     execution result: every signing path still re-quotes first

interface CacheEntry {
  storedAtMs: number;
  value: unknown;
}

const entries = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/** Test/dev helper — drops every cached quote. */
export function resetTradeQuoteCache(): void {
  entries.clear();
  inflight.clear();
}

function prune(nowMs: number, ttlMs: number): void {
  for (const [key, entry] of entries) {
    if (nowMs - entry.storedAtMs >= ttlMs) entries.delete(key);
  }
}

/**
 * Returns the cached value for `key` when it is younger than `ttlMs`,
 * otherwise runs `compute()` once — concurrent callers for the same key
 * share the single in-flight computation. Thrown errors are never cached.
 */
export async function withTradeQuoteCache<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const nowMs = Date.now();
  prune(nowMs, ttlMs);

  const cached = entries.get(key);
  if (cached && nowMs - cached.storedAtMs < ttlMs) {
    return cached.value as T;
  }

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = compute()
    .then((value) => {
      const failed = typeof value === "object" && value !== null && "ok" in value && value.ok === false;
      if (!failed && Date.now() - nowMs < ttlMs) {
        if (entries.size >= 256) entries.delete(entries.keys().next().value!);
        entries.set(key, { storedAtMs: nowMs, value });
      }
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}
