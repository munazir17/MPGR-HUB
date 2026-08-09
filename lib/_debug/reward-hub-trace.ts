// lib/_debug/reward-hub-trace.ts
//
// TEMPORARY — Phase 3F Reward Hub cold-load diagnostic trace ONLY.
// Not wired into any production behavior. Safe to delete this entire
// file, plus the `trace.*` call sites that import it, once the trace
// data has been captured. No production file imports this except the
// ones explicitly instrumented for this diagnostic pass.

import { getRpcDiagnostics } from "@/lib/token/rpc-retry";

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

export const trace = {
  // Call at the start of a phase. Returns a token to pass to trace.end().
  start(label: string, meta?: Record<string, unknown>): number {
    // eslint-disable-next-line no-console
    console.log(`[RewardHub TRACE] ${label} START`, meta ?? "");
    return now();
  },

  // Call at the end of a phase with the token returned by trace.start().
  end(label: string, startedAt: number, meta?: Record<string, unknown>): number {
    const elapsed = now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(`[RewardHub TRACE] ${label} END ${fmt(elapsed)}`, meta ?? "");
    return elapsed;
  },

  // One-off marker with no duration (e.g. cache hit/miss, counts).
  mark(label: string, meta?: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.log(`[RewardHub TRACE] ${label}`, meta ?? "");
  },

  // Snapshots the existing rpc-retry.ts diagnostics counters (read-only —
  // does not modify retry behavior) so retry/backoff cost is visible
  // per-phase without adding any new retry-tracking logic.
  rpcSnapshot(label: string): { totalCalls: number; totalFailures: number; totalRetries: number } {
    const d = getRpcDiagnostics();
    const snap = { totalCalls: d.totalCalls, totalFailures: d.totalFailures, totalRetries: d.totalRetries };
    // eslint-disable-next-line no-console
    console.log(`[RewardHub TRACE] ${label} rpcDiagnostics`, snap);
    return snap;
  },
};
