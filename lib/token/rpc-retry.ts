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

// Full-jitter backoff: delay = random(0, min(maxDelay, base * 2^attempt)).
// Spreads retries out over time so a burst of simultaneous failures (an
// RPC hiccup hitting every in-flight call at once) doesn't cause every
// caller to retry at the exact same moment and re-create the same burst.
function computeBackoffDelay(attempt: number, options: RetryOptions): number {
  const exp = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
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
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.lastError = message;

      if (isLastAttempt) {
        logger.error(`${label} failed after ${attempt + 1} attempt(s)`, { error: message });
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
