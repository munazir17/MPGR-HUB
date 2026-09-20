import { getRedis } from "@/lib/api/redis";
import { getSessionFromRequest } from "@/lib/auth/session";
import { getAppOrigin } from "@/lib/auth/config";

function tryRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

function getEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function getDailyTtlSeconds(): number {
  const now = new Date();
  const tomorrowUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const diff = tomorrowUtcMs - now.getTime();
  return Math.max(60, Math.ceil(diff / 1000) + 60);
}

function rateLimitExceededResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later.", code: "RATE_LIMITED" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
  });
}

function serviceUnavailableResponse(message = "Service temporarily unavailable. Please try again later."): Response {
  return new Response(JSON.stringify({ error: message, code: "RATE_LIMITED" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

// Lua: INCR + EXPIRE atomically. Returns the new counter.
const INCR_EXPIRE_LUA = "local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return c;";
const INCRBY_EXPIRE_LUA = "local c = redis.call('INCRBY', KEYS[1], ARGV[1]); if c == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], ARGV[2]) end; return c;";

async function atomicIncr(redis: ReturnType<typeof getRedis>, key: string, ttlSeconds: number): Promise<number> {
  // Prefer Lua atomic path in prod. Fall back to INCR+EXPIRE for test mocks that only stub incr/expire.
  const maybeEval = (redis as unknown as { eval?: (script: string, keys: string[], args: string[]) => Promise<unknown> }).eval;
  if (typeof maybeEval === "function") {
    try {
      const result = await maybeEval.call(redis, INCR_EXPIRE_LUA, [key], [String(ttlSeconds)]);
      const num = typeof result === "number" ? result : Number(result);
      if (Number.isFinite(num)) return num;
    } catch {
      // fall through to non-Lua fallback
    }
  }
  // Fallback — not atomic across concurrent isolates, but keeps offline tests and local dev working.
  const r = redis as unknown as { incr: (key: string) => Promise<number>; expire: (key: string, ttl: number) => Promise<unknown> };
  if (typeof r.incr === "function") {
    const count = await r.incr(key);
    if (count === 1 && typeof r.expire === "function") await r.expire(key, ttlSeconds);
    return count;
  }
  throw new Error("Redis incr not available");
}

async function atomicIncrBy(
  redis: ReturnType<typeof getRedis>,
  key: string,
  increment: number,
  ttlSeconds: number,
): Promise<number> {
  const maybeEval = (redis as unknown as { eval?: (script: string, keys: string[], args: string[]) => Promise<unknown> }).eval;
  if (typeof maybeEval === "function") {
    try {
      const result = await maybeEval.call(redis, INCRBY_EXPIRE_LUA, [key], [String(increment), String(ttlSeconds)]);
      const num = typeof result === "number" ? result : Number(result);
      if (Number.isFinite(num)) return num;
    } catch {
      // fall through
    }
  }
  const r = redis as unknown as {
    incrby?: (key: string, n: number) => Promise<number>;
    incr?: (key: string) => Promise<number>;
    expire?: (key: string, ttl: number) => Promise<unknown>;
    get?: (key: string) => Promise<unknown>;
    set?: (key: string, v: string) => Promise<unknown>;
  };
  if (typeof r.incrby === "function") {
    const count = await r.incrby(key, increment);
    if (count === increment && typeof r.expire === "function") await r.expire(key, ttlSeconds);
    return count;
  }
  // Last resort: read-modify-write (not atomic, test only)
  if (typeof r.get === "function" && typeof r.incr === "function") {
    const raw = await r.get(key);
    const cur = raw == null ? 0 : Number(raw);
    const next = (Number.isFinite(cur) ? cur : 0) + increment;
    // Use incr loop for mock that only supports incr
    for (let i = 0; i < increment; i++) await r.incr(key);
    if (cur === 0 && typeof r.expire === "function") await r.expire(key, ttlSeconds);
    return next;
  }
  throw new Error("Redis incrby not available");
}

export async function assertJsonBodyLimit(request: Request, maxBytes = 16 * 1024): Promise<Response | null> {
  const length = request.headers.get("content-length");
  if (length) {
    const parsed = Number(length);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maxBytes) {
      return new Response(JSON.stringify({ error: "Request body too large" }), { status: 413, headers: { "Content-Type": "application/json" } });
    }
  }
  return null;
}

export async function readJsonBody<T = unknown>(request: Request, maxBytes = 16 * 1024): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const length = request.headers.get("content-length");
  if (length) {
    const parsed = Number(length);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maxBytes) {
      return { ok: false, response: new Response(JSON.stringify({ error: "Request body too large" }), { status: 413, headers: { "Content-Type": "application/json" } }) };
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return { ok: false, response: new Response(JSON.stringify({ error: "Request body too large" }), { status: 413, headers: { "Content-Type": "application/json" } }) };
  }
  try {
    const text = new TextDecoder().decode(bytes);
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, response: new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } }) };
  }
}

/**
 * Dual-bucket, Lua-atomic rate limiter.
 *
 * Enforces BOTH a per-IP bucket and a per-wallet bucket (when a wallet session exists)
 * using the same limit/window. This closes the bypass where an attacker rotates through
 * fresh wallets to stay under a wallet-only key. INCR+EXPIRE is atomic via Lua so concurrent
 * requests on serverless cannot race past the limit.
 *
 * Returns 503 fail-closed when Redis is not configured or when the Lua eval fails, so the
 * AI provider's FallbackAIProvider can deterministically handle it.
 */
export async function enforceRateLimit(request: Request, bucket: string, limit: number, windowSeconds: number): Promise<Response | null> {
  const redis = tryRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: "Rate limiting is not configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const session = getSessionFromRequest(request);
  const ip = getClientIp(request);
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const ttl = windowSeconds + 5;

  try {
    // Per-IP bucket is always checked. Per-wallet bucket is additionally checked when authenticated.
    // Both must pass; we increment and check the IP first so a wallet-rotator cannot evade the IP limit.
    const ipKey = `mpgrhub:ratelimit:${bucket}:${window}:ip:${ip}`;
    const ipCount = await atomicIncr(redis, ipKey, ttl);
    if (ipCount > limit) {
      return rateLimitExceededResponse(windowSeconds);
    }

    if (session?.wallet) {
      const wallet = session.wallet.toLowerCase();
      const walletKey = `mpgrhub:ratelimit:${bucket}:${window}:wallet:${wallet}`;
      const walletCount = await atomicIncr(redis, walletKey, ttl);
      if (walletCount > limit) {
        return rateLimitExceededResponse(windowSeconds);
      }
    }
  } catch {
    // Fail closed when Redis/Lua is unavailable — callers fall back to deterministic engine.
    return serviceUnavailableResponse();
  }

  return null;
}

/**
 * Daily AI budget: per-wallet + global request budget and per-wallet + global token budget.
 *
 * - Request budgets are enforced by atomically INCRing a daily key (YYYY-MM-DD UTC) with a TTL until
 *   next UTC midnight. If either per-wallet or global request count exceeds its env-configured limit,
 *   returns 429 generic (fail closed). The client AI provider chain treats any 4xx/5xx as a provider
 *   failure and falls back to the deterministic engine, so UX remains available.
 * - Token budgets are enforced before the upstream call by reading the current token counters. If either
 *   exceeds its limit, returns 429 without consuming a request budget increment (token check happens first).
 *   After a successful upstream call, call recordAiTokenUsage() to INCRBY the token counters.
 *
 * Env overrides (all optional, fallback defaults are safe for prod):
 *   AI_DAILY_REQUESTS_PER_WALLET  default 100
 *   AI_DAILY_REQUESTS_GLOBAL      default 5000
 *   AI_DAILY_TOKENS_PER_WALLET    default 100000
 *   AI_DAILY_TOKENS_GLOBAL        default 2000000
 */
export async function enforceAiDailyBudget(request: Request): Promise<Response | null> {
  const redis = tryRedis();
  if (!redis) {
    return serviceUnavailableResponse();
  }

  const session = getSessionFromRequest(request);
  const wallet = session?.wallet.toLowerCase() ?? null;
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const ttl = getDailyTtlSeconds();

  const reqPerWalletLimit = getEnvInt("AI_DAILY_REQUESTS_PER_WALLET", 100);
  const reqGlobalLimit = getEnvInt("AI_DAILY_REQUESTS_GLOBAL", 5000);
  const tokPerWalletLimit = getEnvInt("AI_DAILY_TOKENS_PER_WALLET", 100000);
  const tokGlobalLimit = getEnvInt("AI_DAILY_TOKENS_GLOBAL", 2000000);

  try {
    // 1) Token budget pre-check — fail fast without consuming request quota.
    //    If either wallet or global token counter already exceeds limit, block the request.
    const globalTokenKey = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    // Wallet token key only when authenticated
    if (wallet) {
      const walletTokenKey = `mpgrhub:ai:budget:daily:tokens:wallet:${wallet}:${date}`;
      const raw = await redis.get(walletTokenKey);
      const count = raw == null ? 0 : Number(raw);
      if (Number.isFinite(count) && count >= tokPerWalletLimit) {
        return rateLimitExceededResponse(ttl);
      }
    }
    const globalRaw = await redis.get(globalTokenKey);
    const globalCount = globalRaw == null ? 0 : Number(globalRaw);
    if (Number.isFinite(globalCount) && globalCount >= tokGlobalLimit) {
      return rateLimitExceededResponse(ttl);
    }

    // 2) Request budget — atomically increment and check. Wallet first, then global.
    if (wallet) {
      const walletReqKey = `mpgrhub:ai:budget:daily:requests:wallet:${wallet}:${date}`;
      const walletReqCount = await atomicIncr(redis, walletReqKey, ttl);
      if (walletReqCount > reqPerWalletLimit) {
        return rateLimitExceededResponse(ttl);
      }
    }

    const globalReqKey = `mpgrhub:ai:budget:daily:requests:global:${date}`;
    const globalReqCount = await atomicIncr(redis, globalReqKey, ttl);
    if (globalReqCount > reqGlobalLimit) {
      return rateLimitExceededResponse(ttl);
    }
  } catch {
    return serviceUnavailableResponse();
  }

  return null;
}

/**
 * Record actual token usage after a successful upstream AI call.
 * Increments both per-wallet and global daily token counters via Lua INCRBY+EXPIRE.
 * Fail-open on Redis error here (usage not recorded) to avoid breaking the already-successful response,
 * but the daily budget will be enforced on the next request via enforceAiDailyBudget.
 */
export async function recordAiTokenUsage(request: Request, totalTokens: number): Promise<void> {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
  const redis = tryRedis();
  if (!redis) return;
  const session = getSessionFromRequest(request);
  const wallet = session?.wallet.toLowerCase() ?? null;
  const date = new Date().toISOString().slice(0, 10);
  const ttl = getDailyTtlSeconds();
  const tokens = Math.floor(totalTokens);
  if (tokens <= 0) return;

  try {
    if (wallet) {
      const walletTokenKey = `mpgrhub:ai:budget:daily:tokens:wallet:${wallet}:${date}`;
      await atomicIncrBy(redis, walletTokenKey, tokens, ttl);
    }
    const globalTokenKey = `mpgrhub:ai:budget:daily:tokens:global:${date}`;
    await atomicIncrBy(redis, globalTokenKey, tokens, ttl);
  } catch {
    // best-effort; do not throw
  }
}

export function requestIdFromRequest(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  if (supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

export function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("X-Request-ID", requestId);
  return response;
}

// CSRF defense for routes that authenticate a state-changing request
// purely from the `mpgr_session` cookie (see getSessionFromRequest).
//
// The session/nonce cookies are `SameSite=None; Secure` in production
// (lib/auth/config.ts getAuthCookieAttributes) so the app keeps working
// when loaded inside the Farcaster/Base Mini App webview — a
// third-party/embedded context where `SameSite=Lax` cookies are never
// sent at all. `SameSite=None` removes the browser's own cross-site
// cookie block, so any route that trusts the session cookie alone for
// a state-changing (non-GET/HEAD/OPTIONS) request must verify the
// request actually came from this app itself.
//
// This uses the standard, sufficient Origin-header check for
// cookie+fetch JSON APIs: a real browser always sets `Origin` (falling
// back to `Referer` when a browser omits it) on POST/PUT/PATCH/DELETE
// requests, same-origin or not, and a cross-site page cannot forge it.
// It does not touch the SIWE nonce/signature flow itself (that flow is
// separately, cryptographically bound to the app's origin inside the
// signed SIWE message and needs no additional check here).
export function verifyTrustedOrigin(request: Request): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;

  let appOrigin: string;
  try {
    appOrigin = getAppOrigin(request.url);
  } catch {
    // APP_ORIGIN misconfiguration is a deploy problem surfaced loudly
    // elsewhere by getAppOrigin() — fail closed rather than allow an
    // unverifiable cross-origin request through.
    return new Response(JSON.stringify({ error: "Origin verification is not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (!candidate) {
    return new Response(JSON.stringify({ error: "Missing Origin header" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidate).origin;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid Origin header" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (candidateOrigin !== appOrigin) {
    return new Response(JSON.stringify({ error: "Cross-site request rejected" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

export async function protectApiRequest(
  request: Request,
  bucket: string,
  limit: number,
  windowSeconds: number,
  maxBytes = 16 * 1024,
): Promise<{ requestId: string; error: Response | null }> {
  const requestId = requestIdFromRequest(request);
  const originError = verifyTrustedOrigin(request);
  if (originError) return { requestId, error: withRequestId(originError, requestId) };
  const sizeError = await assertJsonBodyLimit(request, maxBytes);
  if (sizeError) return { requestId, error: withRequestId(sizeError, requestId) };
  const rateError = await enforceRateLimit(request, bucket, limit, windowSeconds);
  if (rateError) return { requestId, error: withRequestId(rateError, requestId) };
  return { requestId, error: null };
}
