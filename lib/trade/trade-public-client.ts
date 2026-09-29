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
//    failed. This is diagnostics only: it changes no retry, ordering,
//    or fail-closed behavior.

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
  at: number;
}

const PROBE_LOG_MAX = 12;
const PROBE_REPORT_WINDOW_MS = 30_000;
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

function pruneProbes(now: number): void {
  while (probeLog.length > 0 && now - probeLog[0].at > PROBE_REPORT_WINDOW_MS) probeLog.shift();
}

function renderProbes(): string {
  return probeLog.map((p) => `${p.origin}→${p.status || "network-error"}`).join(", ");
}

/**
 * viem http-transport `fetchFn` wrapper: passes the request through
 * untouched and records a sanitized outcome for diagnostics. Never
 * retries, never alters the request or response.
 */
async function probingFetchFn(url: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  const origin = safeOrigin(rawUrl);
  try {
    const response = await fetch(url as string, init);
    const now = Date.now();
    pruneProbes(now);
    probeLog.push({ origin, status: response.status, at: now });
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
    probeLog.push({ origin, status: 0, at: now });
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
