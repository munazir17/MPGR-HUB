import { Redis } from "@upstash/redis";
import { getSessionFromRequest } from "@/lib/auth/session";
const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;
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
  if (!redis) return new Response(JSON.stringify({ error: "Rate limiting is not configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
  const session = getSessionFromRequest(request);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const subject = session?.wallet.toLowerCase() ?? forwarded;
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `mpgrhub:ratelimit:${bucket}:${window}:${subject}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds + 5);
  if (count > limit) return new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(windowSeconds) } });
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

export async function protectApiRequest(
  request: Request,
  bucket: string,
  limit: number,
  windowSeconds: number,
  maxBytes = 16 * 1024,
): Promise<{ requestId: string; error: Response | null }> {
  const requestId = requestIdFromRequest(request);
  const sizeError = await assertJsonBodyLimit(request, maxBytes);
  if (sizeError) return { requestId, error: withRequestId(sizeError, requestId) };
  const rateError = await enforceRateLimit(request, bucket, limit, windowSeconds);
  if (rateError) return { requestId, error: withRequestId(rateError, requestId) };
  return { requestId, error: null };
}
