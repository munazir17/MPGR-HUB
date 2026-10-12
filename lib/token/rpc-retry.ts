// lib/token/rpc-retry.ts

import { logger } from "@/lib/architecture/core/logger";
import { MPGR_TOKEN_CONFIG } from "./token-config";
import type { RetryOptions, RpcDiagnostics } from "./token-types";

// Phase 3E Part 2 — RPC Retry & Diagnostics.
//
// Generic exponential-backoff retry wrapper used by every new RPC-facing
// module in this phase (transfer-event-reader.ts today; any future
// RPC-facing module can reuse it the same way). Never changes the return
// type of the wrapped function — callers get T back on success, or the
// wrapped function's own error re-thrown after the final attempt.
//
// This complements, and never duplicates, refresh-manager.ts's own
// address-level debounce: withRetry() retries a single call's transient
// failures (a dropped connection, a momentary RPC timeout); refresh-manager
// decides whether an entire refresh cycle should run at all. Different
// layers, different concerns.
//
// Deliberately framework-free — no dependency on wagmi/viem — so it can
// wrap any async RPC call, not just token-related ones, if a future phase
// needs the same retry behavior elsewhere.

const diagnostics: RpcDiagnostics = {
  totalCalls: 0,
  totalFailures: 0,
  totalRetries: 0,
  lastError: null,
  lastCallDurationMs: 0,
  lastCallAt: null,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimum backoff floor. Full jitter's random(0, exp) can round down to
// ~0ms on early attempts, which lets a retry fire almost immediately back
// into an endpoint that just returned an error — defeating the point of
// backing off. A small fixed floor (well under every config's
// baseDelayMs, so it never overrides the intended backoff curve at later
// attempts) guarantees every retry waits at least this long, while the
// existing random upper bound is untouched — retries still spread out
// under a burst of simultaneous failures instead of retrying in lockstep.
const MIN_BACKOFF_FLOOR_MS = 50;

const NON_RETRYABLE_RPC_CODES = new Set([
  -32700, // Parse error
  -32600, // Invalid Request (including Alchemy Free-tier eth_getLogs 10-block cap)
  -32601, // Method not found
  -32602, // Invalid params
  -32004, // Method not supported
  -32003, // Transaction rejected
  3,      // ExecutionRevertedError
  4001,   // UserRejectedRequestError
  4100,   // UnauthorizedProviderError
  4200,   // UnsupportedProviderMethodError
  4900,
  4901,
  4902,
]);

const NON_RETRYABLE_HTTP_STATUS = new Set([400, 401, 403, 413, 422]);

const NON_RETRYABLE_MESSAGE_RE =
  /\b(\d+)\s*[- ]?block range\b|up to a \d+ block|exceed(?:s|ed)? max(?:imum)?.*range|block range (?:is )?too (?:large|wide)|max(?:imum)? (?:block )?range|query returned more than|more than \d+ results|response size exceeded|log response size|filter not found|execution reverted/i;

const NON_RETRYABLE_NAME_RE =
  /ContractFunctionRevertedError|ExecutionRevertedError|InvalidRequestRpcError|InvalidParamsRpcError|ParseRpcError|MethodNotFoundRpcError|MethodNotSupportedRpcError|UserRejectedRequestError|UnauthorizedProviderError/i;

/**
 * Redacts full URLs (which may embed provider API keys in path or query
 * segments) to origin-only and strips Authorization/Bearer tokens.
 */
export function sanitizeRpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/[^\s"'<>)]+/gi, (match) => {
      try {
        return new URL(match).origin;
      } catch {
        return "<redacted-url>";
      }
    })
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>");
}

/**
 * Returns true when an RPC error is deterministic (invalid JSON-RPC params
 * or request, provider plan block-range cap, HTTP 400/401/403/413/422, or
 * contract execution revert) and retrying the identical request will only
 * amplify failed RPC traffic.
 */
export function isNonRetryableRpcError(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 6 && cursor && typeof cursor === "object"; depth += 1) {
    const rec = cursor as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      name?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    if (typeof rec.status === "number" && NON_RETRYABLE_HTTP_STATUS.has(rec.status)) return true;
    if (typeof rec.statusCode === "number" && NON_RETRYABLE_HTTP_STATUS.has(rec.statusCode)) return true;
    if (typeof rec.code === "number" && NON_RETRYABLE_RPC_CODES.has(rec.code)) return true;
    if (typeof rec.name === "string" && NON_RETRYABLE_NAME_RE.test(rec.name)) return true;
    for (const msg of [rec.shortMessage, rec.message, rec.details]) {
      if (typeof msg === "string" && NON_RETRYABLE_MESSAGE_RE.test(msg)) return true;
    }
    cursor = rec.cause;
  }
  if (typeof err === "string" && NON_RETRYABLE_MESSAGE_RE.test(err)) return true;
  return false;
}

// Full-jitter backoff: delay = random(floor, min(maxDelay, base * 2^attempt)).
// Spreads retries out over time so a burst of simultaneous failures (an
// RPC hiccup hitting every in-flight call at once) doesn't cause every
// caller to retry at the exact same moment and re-create the same burst.
function computeBackoffDelay(attempt: number, options: RetryOptions): number {
  const exp = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  const floor = Math.min(MIN_BACKOFF_FLOOR_MS, exp);
  return Math.floor(floor + Math.random() * (exp - floor));
}

// Runs `fn`, retrying on failure up to options.maxAttempts times with
// exponential backoff between attempts. Re-throws the last error if every
// attempt fails — callers decide how to degrade (return cached data,
// return an empty result, surface an error), matching the "never throws
// past this point" pattern already used throughout lib/token/.
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: RetryOptions = MPGR_TOKEN_CONFIG.retry
): Promise<T> {
  const start = Date.now();
  diagnostics.totalCalls += 1;
  let lastErr: unknown;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      const result = await fn();
      diagnostics.lastCallDurationMs = Date.now() - start;
      diagnostics.lastCallAt = new Date().toISOString();
      return result;
    } catch (err) {
      lastErr = err;
      diagnostics.totalFailures += 1;
      const isLastAttempt = attempt === options.maxAttempts - 1;
      const nonRetryable = isNonRetryableRpcError(err);
      const message = sanitizeRpcErrorMessage(err);
      diagnostics.lastError = message;

      if (isLastAttempt || nonRetryable) {
        logger.error(`${label} failed after ${attempt + 1} attempt(s)`, {
          error: message,
          ...(nonRetryable ? { nonRetryable: true } : {}),
        });
        break;
      }

      diagnostics.totalRetries += 1;
      const delay = computeBackoffDelay(attempt, options);
      logger.debug(`${label} failed, retrying in ${delay}ms`, {
        attempt: attempt + 1,
        maxAttempts: options.maxAttempts,
        error: message,
      });
      await sleep(delay);
    }
  }

  diagnostics.lastCallDurationMs = Date.now() - start;
  diagnostics.lastCallAt = new Date().toISOString();
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Snapshot of rolling RPC diagnostics — for debugging panels, health
// checks, or logging. Returns a copy so callers can't mutate internal state.
export function getRpcDiagnostics(): RpcDiagnostics {
  return { ...diagnostics };
}

// Resets diagnostics counters (useful for tests or a manual "clear stats"
// action). Never called automatically.
export function resetRpcDiagnostics(): void {
  diagnostics.totalCalls = 0;
  diagnostics.totalFailures = 0;
  diagnostics.totalRetries = 0;
  diagnostics.lastError = null;
  diagnostics.lastCallDurationMs = 0;
  diagnostics.lastCallAt = null;
}
