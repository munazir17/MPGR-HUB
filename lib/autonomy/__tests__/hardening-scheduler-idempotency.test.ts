// lib/autonomy/__tests__/hardening-scheduler-idempotency.test.ts
//
// PHASE 4 HARDENING — scheduler leases/stale/retry caps + restart
// idempotency (§5, §11): duplicate ticks, stale/expired leases, retry
// bounding, pause/resume, expiry, and "a restart must never re-broadcast
// an already-submitted execution".

import { describe, expect, it, vi } from "vitest";

import {
  createActiveGoal,
  fundWallet,
  makeDelegatingAdapter,
  makeHarness,
  silentLogger,
  usdc,
  WALLET,
  type TestHarness,
} from "./helpers";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import type { McpGateway } from "@/lib/autonomy/mcp-gateway";
import { AutonomyScheduler } from "@/lib/autonomy/scheduler";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";

async function enabled<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("hardening: scheduler duplicate-tick + lease semantics (§11)", () => {
  it("two concurrent ticks over the same store execute the goal at most once", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 3 });
      const [a, b] = await Promise.all([
        harness.scheduler.tick({ now: harness.now() }),
        harness.scheduler.tick({ now: harness.now() }),
      ]);
      const kinds = [...a.results, ...b.results].map((r) => r.kind);
      expect(kinds.filter((k) => k === "EXECUTION_SUBMITTED")).toHaveLength(1); // one worker won the race
      expect(harness.adapter.options.requests).toHaveLength(1); // ONE broadcast — never two
    }));

  it("an expired lease can be taken over by a new token; a wrong token cannot release it", async () => {
    const harness = makeHarness();
    const ttl = AUTONOMY_LIMITS.evaluationLeaseSeconds;
    expect(await harness.store.tryAcquireGoalLease("g1", "worker-a", ttl)).toBe(true);
    expect(await harness.store.tryAcquireGoalLease("g1", "worker-b", ttl)).toBe(false);
    await harness.store.releaseGoalLease("g1", "worker-b"); // wrong token: no effect
    expect(await harness.store.tryAcquireGoalLease("g1", "worker-b", ttl)).toBe(false);
    harness.advanceClock(ttl * 1000 + 1000); // lease expired
    expect(await harness.store.tryAcquireGoalLease("g1", "worker-b", ttl)).toBe(true);
  });

  it("a delayed tick (missed schedule) evaluates the goal once, not once-per-missed-period", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 3 });
      harness.advanceClock(10 * 60_000); // 10 missed minutes
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(1);
      expect(harness.adapter.options.requests).toHaveLength(1);
    }));

  it("expired goals are closed by the tick without quoting or broadcasting", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 3, expiresAt: new Date(harness.now().getTime() - 1000).toISOString() });
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.results[0].kind).toBe("GOAL_CLOSED");
      expect((await harness.store.getGoal((await listIds(harness))[0]))?.status).toBe("EXPIRED");
      expect(harness.adapter.options.requests).toHaveLength(0);
    }));

  it("paused goals are skipped; resume re-enters evaluation", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 3 });
      await harness.store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { status: "PAUSED", updatedAt: "p1" });
      expect((await harness.scheduler.tick({ now: harness.now() })).evaluated).toBe(0);
      const paused = (await harness.store.getGoal(goal.id))!;
      await harness.store.transitionGoal(goal.id, WALLET, ["PAUSED"], paused.updatedAt, { status: "ACTIVE", updatedAt: "p2" });
      expect((await harness.scheduler.tick({ now: harness.now() })).evaluated).toBe(1);
    }));

  it("repeated failures are bounded: strictly-future retries, and maxConsecutiveFailures FAILS the goal terminally", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 5 });
      harness.state.quoterFails = true; // every evaluation parks with a failure
      for (let i = 0; i < AUTONOMY_LIMITS.maxConsecutiveFailures; i++) {
        const current = (await harness.store.getGoal(goal.id))!;
        if (current.status === "WAITING") {
          await harness.store.transitionGoal(goal.id, WALLET, ["WAITING", "ACTIVE"], current.updatedAt, { updatedAt: `w${i}`, status: "ACTIVE" });
        }
        await harness.runtime.evaluateGoal(goal.id);
        const after = (await harness.store.getGoal(goal.id))!;
        if (after.status !== "FAILED") {
          // Every parked failure schedules a STRICTLY FUTURE retry — the
          // runtime can never storm an endpoint with instant retries.
          const gap = new Date(after.nextEvaluationAt).getTime() - harness.now().getTime();
          expect(gap).toBeGreaterThan(0);
          harness.advanceClock(gap + 1000);
        }
      }
      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("FAILED");
      expect(after.stats.consecutiveFailures).toBe(AUTONOMY_LIMITS.maxConsecutiveFailures);
      harness.advanceClock(600_000);
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("SKIPPED"); // terminal: no retry storm
    }));

  it("repeated execution failures stop at the daily spend limit (conservative over-count, no storm)", async () =>
    enabled(async () => {
      const harness = makeHarness({
        authorized: true,
        requests: [],
        failWith: { code: "EXECUTION_UNAVAILABLE", message: "session wallet unavailable" },
      });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 5 });
      for (let i = 0; i < 4; i++) {
        const current = (await harness.store.getGoal(goal.id))!;
        if (current.status === "WAITING") {
          await harness.store.transitionGoal(goal.id, WALLET, ["WAITING", "ACTIVE"], current.updatedAt, { updatedAt: `w${i}`, status: "ACTIVE" });
        }
        await harness.runtime.evaluateGoal(goal.id);
        const after = (await harness.store.getGoal(goal.id))!;
        const gap = new Date(after.nextEvaluationAt).getTime() - harness.now().getTime();
        expect(gap).toBeGreaterThan(0); // strictly future — never instant
        harness.advanceClock(gap + 1000);
      }
      const final = (await harness.store.getGoal(goal.id))!;
      // Failed broadcast attempts consume daily action slots (conservative);
      // once exhausted the goal parks on POLICY_REJECTED instead of retrying.
      expect(final.stats.consecutiveFailures).toBeLessThanOrEqual(AUTONOMY_LIMITS.maxConsecutiveFailures);
      expect(final.status === "WAITING" || final.status === "FAILED").toBe(true);
      expect(harness.adapter.options.requests).toHaveLength(final.stats.consecutiveFailures); // every broadcast attempt was accounted
    }));
});

describe("hardening: idempotency primitives + restart safety (§5)", () => {
  it("claimExecution: single winner per key, distinct keys independent, TTL expiry releases", async () => {
    const harness = makeHarness();
    expect(await harness.store.claimExecution("key-1", 60)).toBe(true);
    expect(await harness.store.claimExecution("key-1", 60)).toBe(false); // replay rejected
    expect(await harness.store.claimExecution("key-2", 60)).toBe(true);
    harness.advanceClock(61_000); // TTL passed
    expect(await harness.store.claimExecution("key-1", 60)).toBe(true); // expired claims are reclaimable
  });

  it("RESTART: a fresh runtime over the same store verifies the pending execution instead of re-broadcasting", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      expect(harness.adapter.options.requests).toHaveLength(1);

      // --- process restart: brand-new runtime/scheduler/audit over the SAME store data ---
      const perf = new InMemoryPerformanceMonitor();
      const audit = new BusAuditSink(harness.store, harness.bus, perf);
      const restarted = new AutonomyRuntime({
        store: harness.store,
        gateway: (harness.runtime as unknown as { deps: { gateway: McpGateway } }).deps.gateway,
        adapter: harness.adapter,
        audit,
        logger: silentLogger,
        performanceMonitor: perf,
        now: harness.now,
      });
      const restartedScheduler = new AutonomyScheduler(harness.store, restarted, silentLogger, perf);

      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      // The scheduler still sees the goal as due (EXECUTING + verification due)…
      const summary = await restartedScheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(1);
      // …and the outcome is VERIFICATION/COMPLETION, never a second broadcast.
      expect(harness.adapter.options.requests).toHaveLength(1);
      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("COMPLETED");
      expect(after.pendingExecution).toBeNull();
    }));

  it("terminal goals are never re-evaluated after restart (no double execution)", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      await harness.runtime.evaluateGoal(goal.id);
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      await harness.runtime.evaluateGoal(goal.id); // verified -> COMPLETED
      harness.advanceClock(600_000);
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("SKIPPED");
      expect(harness.adapter.options.requests).toHaveLength(1);
    }));

  it("emergency stop mid-flight: in-flight verification still completes, and nothing new broadcasts while disabled", async () =>
    enabled(async () => {
      vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 2 });
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "false"); // emergency stop AFTER broadcast

      // In-flight verification is NOT blocked by the flag being off:
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      await harness.runtime.evaluateGoal(goal.id); // completes pending verification bookkeeping
      expect(harness.adapter.options.requests).toHaveLength(1);

      // No NEW execution while disabled — advance past the post-verification
      // cooldown so the goal is DUE again; the tick must report disabled.
      harness.advanceClock(15 * 60_000);
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.disabled).toBe(true);
      expect(harness.adapter.options.requests).toHaveLength(1);
      vi.unstubAllEnvs();
    }));
});

async function listIds(harness: TestHarness): Promise<string[]> {
  return (await harness.store.listGoals(WALLET)).map((g) => g.id);
}

// keep the adapter factory referenced for future scoped extensions (tree-shake guard)
void makeDelegatingAdapter;
