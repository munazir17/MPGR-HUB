// Unresolved broadcast — a tick interrupted after its execution claim or its
// attempt marker was written, with no transaction hash recorded.
//
// Required behavior, pinned here:
//   - The next tick selects the goal and closes it FAILED, with lastResult stating
//     the broadcast outcome is UNKNOWN, that nothing is retried automatically, and
//     that a human must reconcile.
//   - No new evaluation slot is opened, and the adapter (executeSwap) is never
//     called again.
//   - A goal holding a transaction hash (pendingExecution) keeps the verification
//     path and is never closed here.
//   - A live tick that still holds the goal lease is never closed underneath.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { executionKeyForSlot } from "@/lib/autonomy/idempotency";
import { createActiveGoal, fundWallet, makeHarness, usdc, type TestHarness } from "./helpers";

function dayOf(h: TestHarness): string {
  return h.now().toISOString().slice(0, 10);
}

async function enabled<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("unresolved broadcast — a claim or marker left by an interrupted tick", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(harness.state, usdc("100"));
  });

  it("killed after the claim and BEFORE the attempt marker: closed as UNKNOWN on the next tick, adapter never called", async () =>
    enabled(async () => {
      const h = harness;
      const { goal, policy } = await createActiveGoal(h, { maxTrades: 3 });
      let markerCalls = 0;
      let adapterCalls = 0;
      h.adapter.executeSwap = () => {
        adapterCalls += 1;
        return new Promise<never>(() => {});
      };
      // The tick is killed at the attempt marker: it never returns (fake timers
      // stand in for the process being stopped mid-call).
      h.store.markSpendAttempt = () => {
        markerCalls += 1;
        return new Promise<never>(() => {});
      };

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        void h.runtime.evaluateGoal(goal.id);
        for (let i = 0; i < 200 && markerCalls === 0; i += 1) {
          await vi.advanceTimersByTimeAsync(5);
        }
        expect(markerCalls).toBe(1);
        expect(adapterCalls).toBe(0);

        const killed = (await h.store.getGoal(goal.id))!;
        expect(killed.status).toBe("ACTIVE");
        const execId = executionKeyForSlot(goal.id, killed.nextEvaluationAt);
        expect(await h.store.hasExecutionClaim(execId)).toBe(true);
      } finally {
        vi.useRealTimers();
      }

      h.advanceClock(AUTONOMY_LIMITS.evaluationLeaseSeconds * 1000 + 1000);
      const summary = await h.scheduler.tick({ now: h.now() });
      expect(summary.results).toEqual([{ goalId: goal.id, kind: "UNRESOLVED_BROADCAST" }]);

      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("FAILED");
      expect(after.lastResult).toMatchObject({ outcome: "FAILED", code: "TIMEOUT" });
      expect(after.lastResult?.message).toMatch(/Broadcast outcome UNKNOWN/);
      expect(after.lastResult?.message).toMatch(/human must reconcile/);
      // Nothing was reached again. The reservation the interrupted tick took stays
      // counted (never released here), so the day's spend is still 20 USDC.
      expect(adapterCalls).toBe(0);
      expect(h.adapter.options.requests).toHaveLength(0);
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
      expect(policy.id).toBeTruthy();
    }));

  it("no new evaluation slot: the closed goal is never reopened, even after the claim would have expired", async () =>
    enabled(async () => {
      const h = harness;
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      // An interrupted tick left the claim on this slot, with no hash.
      expect(await h.store.claimExecution(executionKeyForSlot(goal.id, goal.nextEvaluationAt), AUTONOMY_LIMITS.executionGuardSeconds)).toBe(true);

      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("UNRESOLVED_BROADCAST");
      const closed = (await h.store.getGoal(goal.id))!;
      expect(closed.status).toBe("FAILED");
      expect(closed.nextEvaluationAt).toBe(closed.updatedAt);

      // Far past the claim TTL: the goal is terminal, so no slot is ever evaluated.
      h.advanceClock(AUTONOMY_LIMITS.executionGuardSeconds * 1000 + 1000);
      const later = await h.scheduler.tick({ now: h.now() });
      expect(later.results.some((r) => r.goalId === goal.id)).toBe(false);
      expect(h.adapter.options.requests).toHaveLength(0);
      expect((await h.store.getGoal(goal.id))!.status).toBe("FAILED");
    }));

  it("the condition no longer holds on the next tick: the goal is still closed as UNKNOWN, not moved to a new slot (no later re-trade)", async () =>
    enabled(async () => {
      const h = harness;
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      // The interrupted tick left the claim on this slot, with no hash.
      expect(await h.store.claimExecution(executionKeyForSlot(goal.id, goal.nextEvaluationAt), AUTONOMY_LIMITS.executionGuardSeconds)).toBe(true);
      // The live quote would now fail the condition (price_below 1).
      await h.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE"], goal.updatedAt, {
        condition: { kind: "price_below", threshold: "1" },
        updatedAt: "condition-edit",
      });

      const result = await h.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("UNRESOLVED_BROADCAST");
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("FAILED");
      expect(after.lastResult?.outcome).toBe("FAILED");
      expect(h.adapter.options.requests).toHaveLength(0);
    }));

  it("a live tick holding the goal lease is never closed underneath: LEASE_BUSY, goal untouched", async () =>
    enabled(async () => {
      const h = harness;
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      expect(await h.store.claimExecution(executionKeyForSlot(goal.id, goal.nextEvaluationAt), AUTONOMY_LIMITS.executionGuardSeconds)).toBe(true);
      expect(await h.store.tryAcquireGoalLease(goal.id, "live-tick", AUTONOMY_LIMITS.evaluationLeaseSeconds)).toBe(true);

      const busy = await h.runtime.evaluateGoal(goal.id);
      expect(busy.kind).toBe("SKIPPED");
      expect(busy).toMatchObject({ reason: "LEASE_BUSY" });
      const untouched = (await h.store.getGoal(goal.id))!;
      expect(untouched.status).toBe("ACTIVE");
      expect(untouched.lastResult).toBeFalsy();

      // Once the lease is free, the goal is closed.
      await h.store.releaseGoalLease(goal.id, "live-tick");
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("UNRESOLVED_BROADCAST");
      expect(h.adapter.options.requests).toHaveLength(0);
    }));

  it("a goal that holds a transaction hash keeps the verification path and is never closed as UNKNOWN", async () =>
    enabled(async () => {
      const h = harness;
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");

      // The claim for this slot is held, and the goal is EXECUTING with the hash.
      const submitted = (await h.store.getGoal(goal.id))!;
      expect(submitted.status).toBe("EXECUTING");
      expect(submitted.pendingExecution?.txHash).toMatch(/^0x/);

      h.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      const verdict = await h.runtime.evaluateGoal(goal.id);
      expect(verdict.kind).toBe("VERIFIED");
      expect(h.adapter.options.requests).toHaveLength(1);
    }));
});
