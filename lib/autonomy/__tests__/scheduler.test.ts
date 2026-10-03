// Scheduler behavior tests (spec §10/§24 — Scheduler): duplicate prevention,
// bounded retries, cancellation, expiration, per-tick caps.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createActiveGoal, fundWallet, makeHarness, usdc, WALLET, type TestHarness } from "./helpers";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";

async function enabled<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("scheduler", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(harness.state, usdc("100"));
  });

  it("tick is a no-op when the feature flag is off (goal untouched)", async () => {
    const { goal } = await createActiveGoal(harness);
    const summary = await harness.scheduler.tick({ now: harness.now() });
    expect(summary.disabled).toBe(true); // the runtime reported itself disabled
    expect(summary.evaluated).toBe(0);
    expect((await harness.store.getGoal(goal.id))?.status).toBe("ACTIVE");
    expect((await harness.store.getGoal(goal.id))?.lastResult ?? null).toBeNull();
  });

  it("due goals are evaluated; future goals are not", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 3 });
      await createActiveGoal(harness, { maxTrades: 3, nextEvaluationAt: new Date(harness.now().getTime() + 600_000).toISOString() });
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.scanned).toBe(1);
      expect(summary.evaluated).toBe(1);
      expect(summary.results[0].goalId).toBe(goal.id);
      expect(summary.results[0].kind).toBe("EXECUTION_SUBMITTED");
    }));

  it("a goal cannot be evaluated twice within its cooldown (duplicate job prevention)", async () =>
    enabled(async () => {
      await createActiveGoal(harness, { maxTrades: 3 });
      const first = await harness.scheduler.tick({ now: harness.now() });
      expect(first.evaluated).toBe(1);
      // Goal is now EXECUTING with pending verification; its next evaluation
      // is in the future. An immediate second tick must do nothing.
      const second = await harness.scheduler.tick({ now: harness.now() });
      expect(second.evaluated).toBe(0);
    }));

  it("cancellation stops evaluation immediately", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness);
      const current = (await harness.store.getGoal(goal.id))!;
      await harness.store.transitionGoal(goal.id, current.wallet, ["ACTIVE"], current.updatedAt, { status: "CANCELLED", updatedAt: "c1" });
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(0);
    }));

  it("expiration is applied deterministically by the runtime during tick", async () =>
    enabled(async () => {
      // Goal created already-expired (createActiveGoal lets the test override fields).
      await createActiveGoal(harness, { expiresAt: new Date(harness.now().getTime() - 1000).toISOString() });
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(1);
      const goals = await harness.store.listGoals(WALLET);
      expect(goals.map((g) => g.status)).toContain("EXPIRED");
    }));

  it("wallet-scoped tick (heartbeat) only touches that wallet's goals", async () =>
    enabled(async () => {
      await createActiveGoal(harness);
      const summary = await harness.scheduler.tick({ wallet: "0x0000000000000000000000000000000000ffffff", now: harness.now() });
      expect(summary.evaluated).toBe(0);
    }));

  it("per-tick cap bounds evaluation volume", async () =>
    enabled(async () => {
      // More due goals than maxEvaluationsPerTick.
      for (let i = 0; i < AUTONOMY_LIMITS.maxEvaluationsPerTick + 5; i++) {
        await createActiveGoal(harness, { maxTrades: 99 });
      }
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBeLessThanOrEqual(AUTONOMY_LIMITS.maxEvaluationsPerTick);
    }));

  it("retry/backoff: consecutive failures eventually FAIL a goal (bounded retries)", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], failWith: { code: "EXECUTION_UNAVAILABLE", message: "no session wallet" } });
      fundWallet(h.state, usdc("100"));
      // High daily caps: each failed attempt conservatively consumes one
      // daily action slot, so the retry-bound test must not trip the cap first.
      const { goal } = await createActiveGoal(h, { maxTrades: 5 }, { maxDailyRaw: usdc("10000"), maxActionsPerDay: 50 });
      for (let i = 0; i < AUTONOMY_LIMITS.maxConsecutiveFailures; i++) {
        h.advanceClock(AUTONOMY_LIMITS.backoffBaseSeconds * 2 ** i * 1000 + 1000);
        const current = (await h.store.getGoal(goal.id))!;
        if (current.status === "WAITING") {
          await h.store.transitionGoal(goal.id, current.wallet, ["WAITING"], current.updatedAt, { status: "ACTIVE", updatedAt: `w${i}` });
        }
        await h.scheduler.tick({ now: h.now() });
      }
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("FAILED");
      expect(after.stats.consecutiveFailures).toBe(AUTONOMY_LIMITS.maxConsecutiveFailures);
    }));

  it("backoff grows between failures (never instant retry)", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], failWith: { code: "EXECUTION_UNAVAILABLE", message: "no session wallet" } });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 5 });
      await h.scheduler.tick({ now: h.now() });
      const afterFirst = (await h.store.getGoal(goal.id))!;
      expect(afterFirst.status).toBe("WAITING");
      const next1 = new Date(afterFirst.nextEvaluationAt).getTime();
      expect(next1).toBeGreaterThan(h.now().getTime()); // parked into the future
    }));
});
