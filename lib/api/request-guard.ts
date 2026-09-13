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

export async function enforceRateLimit(request: Request, bucket: string, limit: number, windowSeconds: number): Promise<Response | null> {
  const redis = tryRedis();
  if (!redis) {
    return new Response(JSON.stringify({ error: "Rate limiting is not configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const session = getSessionFromRequest(request);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const subject = session?.wallet.toLowerCase() ?? forwarded;
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `mpgrhub:ratelimit:${bucket}:${window}:${subject}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds + 5);
  if (count > limit) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(windowSeconds) },
    });
  }
  return null;
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
