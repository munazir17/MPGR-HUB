// lib/trade/trade-public-client.ts
//
// Server-safe viem public client for Base reads (B20 / Chainlink /
// Aerodrome Slipstream). Does not use wagmi connectors — those are
// wallet/browser concerns.
//
// mainnet.base.org rate-limits; fall back to a public endpoint so
// B20 quotes do not 429 in production.
//
// RPC transport hardening (additive, behavior-preserving):
//  - bounded per-transport timeouts (12 s) inside a viem `fallback`
//    transport with STRICT ordering (no latency re-ranking): the
//    configured server URL is always tried first, public defaults last;
//  - viem applies the client-level retry policy (3 retries, 150→600 ms
//    backoff) around the whole chain — finite, never infinite;
//  - every transport outcome is recorded in a small sanitized ring
//    buffer (protocol+origin ONLY — never paths, query strings, basic
//    auth, or API keys: providers commonly embed secrets in the URL
//    path, so only `URL.origin` is ever logged) and the FIRST failure in
//    any 30 s window emits ONE console line identifying which transport
//    failed. Each entry also carries the JSON-RPC METHOD NAME (a protocol
//    constant read from the request body; params are never read) and, for
//    a FAILED HTTP response, the numeric JSON-RPC error code (read from a
//    clone of the body under a HARD byte ceiling — the read stops at 8 KiB
//    and the clone's branch cancel is fire-and-forget, so a missing or
//    lying Content-Length cannot make it unbounded and the tee can never
//    block the return; provider wording is never logged). This is diagnostics
//    only: it changes no retry, ordering, or fail-closed behavior. Known
//    limit: a JSON-RPC error body delivered with HTTP 200 still records as
//    `200` — the success path never reads bodies, so it stays free of
//    per-call overhead.

import { createPublicClient, fallback, http } from "viem";
import { base } from "wagmi/chains";

const DEFAULT_TIMEOUT_MS = 12_000;

export function rpcUrls(): string[] {
  const urls = [
    process.env.BASE_RPC_URL?.trim(),
    process.env.NEXT_PUBLIC_BASE_RPC_URL?.trim(),
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
  ].filter((url): url is string => !!url && url.length > 0);
  return [...new Set(urls)];
}

// --- sanitized transport diagnostics (no secrets ever) ----------------

interface RpcProbeEntry {
  origin: string;
  /** HTTP status, or 0 for network-level failure (refused/DNS/timeout). */
  status: number;
  /** JSON-RPC method name (shape-validated), or null when unreadable. */
  method: string | null;
  /** Numeric JSON-RPC error code from a failed response body, or null. */
  rpcCode: number | null;
  at: number;
}

const PROBE_LOG_MAX = 12;
const PROBE_REPORT_WINDOW_MS = 30_000;
/** Bound for reading a failed response's body purely for its numeric code. */
const PROBE_MAX_ERROR_BODY_BYTES = 8_192;
/** JSON-RPC method names are protocol constants: `eth_getLogs`, `eth_call`, ... */
const RPC_METHOD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const probeLog: RpcProbeEntry[] = [];
let lastReportedAt = 0;

/** protocol+host+port only. Providers embed keys in PATHS — never log them. */
function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "<configured-rpc>";
  }
}

/**
 * The JSON-RPC method name from the request body, or null. Only a
 * shape-validated method string ever leaves this function: request params,
 * headers, and payloads are never read or logged.
 */
function safeMethod(body: unknown): string | null {
  if (typeof body !== "string" || !body.includes('"method"')) return null;
  try {
    const parsed = JSON.parse(body) as { method?: unknown };
    const method = parsed?.method;
    return typeof method === "string" && RPC_METHOD_RE.test(method) ? method : null;
  } catch {
    return null;
  }
}

/** `Content-Length` as a non-negative integer, or null when missing/unusable. */
function declaredBodySize(header: string | null): number | null {
  if (header === null) return null;
  const value = header.trim();
  // Rejects empty, signed, fractional, exponential, and absurdly long values.
  if (!/^\d{1,12}$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

/**
 * Asks a reader to cancel WITHOUT waiting for the result.
 *
 * FIRE-AND-FORGET IS REQUIRED, not tidiness. `response.clone()` tees the body,
 * and per the WHATWG streams tee semantics a branch's `cancel()` promise only
 * settles once BOTH branches have cancelled — and the other branch belongs to
 * viem, which never cancels it. `await reader.cancel()` here therefore leaves
 * the promise pending forever, which would stop readBoundedBody() from ever
 * returning and turn a provider error into a transport timeout. The byte
 * ceiling does not depend on the cancel: reading simply stops.
 */
function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {
      // The branch may already be errored or closed; there is nothing to undo.
    });
  } catch {
    // reader.cancel() threw synchronously (already released/invalidated).
  }
}

/**
 * Reads at most `maxBytes` from a CLONE of `response` and decodes them as
 * UTF-8. Beyond the limit the read STOPS immediately — no further chunk is
 * pulled, and the clone's branch is asked to cancel on a fire-and-forget basis
 * (see cancelQuietly) — so a missing, invalid, or lying `Content-Length` can
 * never turn this into an unbounded read, and the outer call is never made to
 * wait on the tee. The ORIGINAL response is never consumed or mutated: the
 * clone has its own stream, and stopping our branch leaves viem's read intact.
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string | null> {
  const clone = response.clone();
  const body = clone.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      // Checked BEFORE the bytes are kept: the buffer never exceeds maxBytes.
      if (total > maxBytes) {
        cancelQuietly(reader);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    cancelQuietly(reader);
    return null;
  }
}

/**
 * Best-effort numeric JSON-RPC error code for a FAILED response, read from a
 * CLONE of the body so viem's own read of the original response is untouched.
 *
 * STRICTLY SIZE-BOUNDED (review finding): a declared size over the limit is
 * never read at all, and everything else goes through readBoundedBody(),
 * whose read stops at PROBE_MAX_ERROR_BODY_BYTES (its branch cancel is
 * fire-and-forget, so the tee can never block the return). A missing or
 * invalid `Content-Length` is NOT trusted and is never read unbounded.
 *
 * JSON content type is required. Any problem — oversized body, malformed
 * JSON, read failure, unexpected shape, non-integer or absent code — yields
 * null, and the diagnostic simply omits the code. Only an integer is ever
 * returned, so provider wording, request params, and API-key-bearing URLs
 * cannot leave this function.
 *
 * Exported for tests only; production callers reach it via probingFetchFn().
 */
export async function readRpcErrorCode(response: Response): Promise<number | null> {
  try {
    if (!(response.headers.get("Content-Type") ?? "").includes("json")) return null;
    // Cheap rejection first: a declared size over the limit is never read,
    // not even partially. An absent/unusable header is not a green light —
    // readBoundedBody() is what actually enforces the ceiling.
    const declared = declaredBodySize(response.headers.get("Content-Length"));
    if (declared !== null && declared > PROBE_MAX_ERROR_BODY_BYTES) return null;
    const text = await readBoundedBody(response, PROBE_MAX_ERROR_BODY_BYTES);
    if (text === null) return null;
    const data = JSON.parse(text) as { error?: unknown; code?: unknown } | null;
    const envelope = data?.error;
    const raw = envelope && typeof envelope === "object" ? (envelope as { code?: unknown }).code : data?.code;
    return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
  } catch {
    return null;
  }
}

function pruneProbes(now: number): void {
  while (probeLog.length > 0 && now - probeLog[0].at > PROBE_REPORT_WINDOW_MS) probeLog.shift();
}

function renderProbes(): string {
  return probeLog
    .map((p) => {
      const detail = p.method ? ` ${p.method}${p.rpcCode === null ? "" : ` code=${p.rpcCode}`}` : "";
      return `${p.origin}→${p.status || "network-error"}${detail}`;
    })
    .join(", ");
}

/**
 * viem http-transport `fetchFn` wrapper: passes the request through
 * untouched and records a sanitized outcome for diagnostics. Never
 * retries, never alters the request or response. On a FAILED response a
 * bounded clone of the body is read for its numeric JSON-RPC code only —
 * the original response object is handed to viem exactly as received.
 */
async function probingFetchFn(url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const origin = safeOrigin(rawUrl);
  const method = safeMethod(init?.body);
  try {
    const response = await fetch(url as string, init);
    const now = Date.now();
    // Failure path only: the success path reads no body at all, so healthy
    // trade reads carry no extra work beyond the method-name parse above.
    const rpcCode = response.ok ? null : await readRpcErrorCode(response);
    pruneProbes(now);
    probeLog.push({ origin, status: response.status, method, rpcCode, at: now });
    if (probeLog.length > PROBE_LOG_MAX) probeLog.shift();
    if (!response.ok && now - lastReportedAt > PROBE_REPORT_WINDOW_MS) {
      lastReportedAt = now;
      // Origin-only line — safe for logs even if an operator embeds a
      // keyed RPC URL (paths/credentials/query are never included).
      console.error(`[base-rpc] transport failure (fail-closed guards still apply): recent transports: ${renderProbes()}`);
    }
    return response;
  } catch (error) {
    const now = Date.now();
    pruneProbes(now);
    probeLog.push({ origin, status: 0, method, rpcCode: null, at: now });
    if (probeLog.length > PROBE_LOG_MAX) probeLog.shift();
    if (now - lastReportedAt > PROBE_REPORT_WINDOW_MS) {
      lastReportedAt = now;
      console.error(`[base-rpc] transport failure (fail-closed guards still apply): recent transports: ${renderProbes()}`);
    }
    throw error;
  }
}

/**
 * Builds the Base read client over an ordered fallback chain. Exported
 * for tests — production callers use getTradePublicClient().
 */
export function createBaseRpcClient(
  urls: string[] = rpcUrls(),
  opts: { timeoutMs?: number } = {},
) {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return createPublicClient({
    chain: base,
    transport: fallback(urls.map((url) => http(url, { timeout, fetchFn: probingFetchFn }))),
  });
}

/** Human-readable, sanitized snapshot of recent transport outcomes. */
export function describeBaseRpcHealth(): string {
  pruneProbes(Date.now());
  return probeLog.length > 0 ? renderProbes() : "no recent transport failures recorded";
}

/** Test-only: clear the diagnostics ring and report window. */
export function resetBaseRpcProbeForTests(): void {
  probeLog.length = 0;
  lastReportedAt = 0;
}

export function getTradePublicClient() {
  return createBaseRpcClient();
}
