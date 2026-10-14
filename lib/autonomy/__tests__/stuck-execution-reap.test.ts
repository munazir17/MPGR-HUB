// Regression tests — the stuck-execution reap and the crash window around it.
//
// The runtime writes EXECUTING (together with `pendingExecution.txHash`) only
// AFTER the adapter has returned a transaction hash. The goal stays ACTIVE/WAITING
// while a broadcast is in flight, so a tick killed inside the adapter never leaves
// an EXECUTING goal behind. The stuck-execution reap only closes goals that ARE
// EXECUTING with no pending execution, which older builds could leave behind.
//
// A tick killed after its claim or attempt marker was written is closed on the
// next tick as an UNKNOWN broadcast outcome (see the unresolved-broadcast closure
// in runtime.ts). It is never re-broadcast, and the reap is not involved.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { executionKeyForSlot } from "@/lib/autonomy/idempotency";
import { STUCK_EXECUTION_REAP_SECONDS, type AgentGoal, type AutonomyPolicy } from "@/lib/autonomy/types";
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

/** Advance past the stuck-execution reap window. */
function pastReapWindow(h: TestHarness): void {
  h.advanceClock(STUCK_EXECUTION_REAP_SECONDS * 1000 + 1000);
}

function reservationState(h: TestHarness, policyId: string, execId: string): string | undefined {
  return h.store.dayHashes.get(`${policyId}:${dayOf(h)}`)?.reservations.get(execId)?.state;
}

/**
 * Recreate the exact state a crashed tick leaves behind: EXECUTING, no
 * pendingExecution, the "submitting transaction" result string — plus the
 * daily-spend reservation the ACT path had already taken for this slot.
 */
async function leaveStuckExecution(
  h: TestHarness,
  options: { attemptMarked?: boolean } = {},
): Promise<{ goal: AgentGoal; policy: AutonomyPolicy; execId: string }> {
  const { goal, policy } = await createActiveGoal(h, { maxTrades: 3 });
  const at = h.now().toISOString();
  const stuck = await h.store.transitionGoal(goal.id, goal.wallet, ["ACTIVE"], goal.updatedAt, {
    status: "EXECUTING",
    lastEvaluationAt: at,
    updatedAt: at,
    lastAction: "executing authorized swap",
    lastResult: { at, outcome: "TRADE_EXECUTED", code: null, message: "Authorization verified — submitting transaction." },
  });
  expect(stuck).not.toBeNull();
  // Same key the ACT path claimed (and the reap re-derives) for this slot.
  const execId = executionKeyForSlot(goal.id, stuck!.nextEvaluationAt);
  await h.store.reserveDailySpend({
    policyId: policy.id,
    dayKey: dayOf(h),
    execId,
    amountRaw: goal.trade.sellAmountRaw,
    maxDailyRaw: policy.maxDailyRaw,
    maxActions: policy.maxActionsPerDay,
  });
  if (options.attemptMarked) await h.store.markSpendAttempt(policy.id, dayOf(h), execId);
  return { goal: stuck!, policy, execId };
}

describe("stuck-execution reap (crashed tick left the goal EXECUTING)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(harness.state, usdc("100"));
  });

  it("reaps to FAILED after the reap window — and the scheduler can select it again", async () =>
    enabled(async () => {
      const h = harness;
      const { goal } = await leaveStuckExecution(h);

      pastReapWindow(h);
      const summary = await h.scheduler.tick({ now: h.now() });

      expect(summary.scanned).toBe(1); // previously 0 — the goal was unreachable
      expect(summary.results[0]).toEqual({ goalId: goal.id, kind: "STUCK_EXECUTION_REAPED" });

      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("FAILED");
      expect(after.pendingExecution).toBeNull();
      expect(after.lastResult?.outcome).toBe("FAILED");
      expect(after.lastResult?.code).toBe("EXECUTION_UNAVAILABLE");
      expect(after.lastResult?.message).toMatch(/nothing was broadcast/i);
      expect(after.lastResult?.message).toMatch(/no automatic retry/i);

      // No tx hash is invented anywhere, and the swap is not retried.
      const actions = await h.store.listActionRecords(goal.id);
      expect(actions).toHaveLength(1);
      expect(actions[0].txHash).toBeUndefined();
      expect(actions[0].verified).toBe(false);
      expect(h.adapter.options.requests).toHaveLength(0);
    }));

  it("leaves the goal EXECUTING inside the reap window (a live tick is not interrupted)", async () =>
    enabled(async () => {
      const h = harness;
      const { goal, policy } = await leaveStuckExecution(h);

      h.advanceClock(STUCK_EXECUTION_REAP_SECONDS * 1000 - 5_000);
      const summary = await h.scheduler.tick({ now: h.now() });

      expect(summary.scanned).toBe(0);
      expect((await h.store.getGoal(goal.id))!.status).toBe("EXECUTING");
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    }));

  it("releases an unattempted daily reservation (attempt marker never set)", async () =>
    enabled(async () => {
      const h = harness;
      const { goal, policy, execId } = await leaveStuckExecution(h);
      expect(reservationState(h, policy.id, execId)).toBe("RESERVED");

      pastReapWindow(h);
      await h.scheduler.tick({ now: h.now() });

      expect((await h.store.getGoal(goal.id))!.status).toBe("FAILED");
      expect(reservationState(h, policy.id, execId)).toBe("RELEASED");
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
    }));

  it("keeps the spend counted when the attempt marker was set (an unrecorded broadcast stays possible)", async () =>
    enabled(async () => {
      const h = harness;
      const { goal, policy, execId } = await leaveStuckExecution(h, { attemptMarked: true });
      expect(reservationState(h, policy.id, execId)).toBe("ATTEMPTING");

      pastReapWindow(h);
      await h.scheduler.tick({ now: h.now() });

      // The goal is still closed out — it can never progress on its own.
      expect((await h.store.getGoal(goal.id))!.status).toBe("FAILED");
      // …but the UNATTEMPTED release is state-refused: spend stays counted.
      expect(reservationState(h, policy.id, execId)).toBe("ATTEMPTING");
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    }));

  it("never reaps a goal whose evaluation lease is still held", async () =>
    enabled(async () => {
      const h = harness;
      const { goal, policy } = await leaveStuckExecution(h);
      pastReapWindow(h);

      // Another invocation is still working this goal inside its lease.
      expect(await h.store.tryAcquireGoalLease(goal.id, "live-tick", AUTONOMY_LIMITS.evaluationLeaseSeconds)).toBe(true);
      const summary = await h.scheduler.tick({ now: h.now() });

      expect(summary.skippedBusy).toBe(1);
      expect((await h.store.getGoal(goal.id))!.status).toBe("EXECUTING");
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    }));

  it("reaps even while the autonomy flag is off — cleanup never needs to broadcast", async () => {
    const h = harness;
    const { goal } = await leaveStuckExecution(h);
    pastReapWindow(h);

    const summary = await h.scheduler.tick({ now: h.now() });

    expect(summary.evaluated).toBe(1);
    expect((await h.store.getGoal(goal.id))!.status).toBe("FAILED");
    expect((await h.store.getGoal(goal.id))!.lastResult?.message).toMatch(/nothing was broadcast/i);
  });

  it("a tick killed inside the execution adapter is closed as UNKNOWN on the next tick — never re-broadcast, never a new slot", async () =>
    enabled(async () => {
      const h = harness;
      const { goal, policy } = await createActiveGoal(h, { maxTrades: 3 });
      let adapterCalls = 0;
      h.adapter.executeSwap = () => {
        adapterCalls += 1;
        return new Promise<never>(() => {});
      };

      // The tick "dies" inside the adapter: the promise never settles and the
      // runtime's budget timer never fires (fake timers stand in for a serverless
      // kill that stops the process).
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        void h.runtime.evaluateGoal(goal.id);
        for (let i = 0; i < 200 && adapterCalls === 0; i += 1) {
          await vi.advanceTimersByTimeAsync(5);
        }
        expect(adapterCalls).toBe(1);

        // While in flight and after the kill: NOT EXECUTING, no hash recorded.
        const killed = (await h.store.getGoal(goal.id))!;
        expect(killed.status).toBe("ACTIVE");
        expect(killed.pendingExecution).toBeNull();

        // The claim and the attempt marker were both written before the adapter.
        const execId = executionKeyForSlot(goal.id, killed.nextEvaluationAt);
        expect(await h.store.hasExecutionClaim(execId)).toBe(true);
        expect(reservationState(h, policy.id, execId)).toBe("ATTEMPTING");

        // Past the reap window and the evaluation lease, the next tick selects the
        // goal and closes it as UNKNOWN — the reap is not what closes it.
        pastReapWindow(h);
        const summary = await h.scheduler.tick({ now: h.now() });
        expect(summary.results).toEqual([{ goalId: goal.id, kind: "UNRESOLVED_BROADCAST" }]);
        const after = (await h.store.getGoal(goal.id))!;
        expect(after.status).toBe("FAILED");
        expect(after.lastResult).toMatchObject({ outcome: "FAILED", code: "TIMEOUT" });
        expect(after.lastResult?.message).toMatch(/Broadcast outcome UNKNOWN/);
        expect(after.lastResult?.message).toMatch(/Nothing will be retried automatically/);

        // The adapter is never called again, the spend stays counted, and no later
        // tick reopens the goal or opens a new slot.
        expect(adapterCalls).toBe(1);
        expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
        const later = await h.scheduler.tick({ now: h.now() });
        expect(later.results.some((r) => r.goalId === goal.id)).toBe(false);
        expect((await h.store.getGoal(goal.id))!.status).toBe("FAILED");
        expect(adapterCalls).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    }));

  it("does not touch a goal that is EXECUTING with a recorded transaction", async () =>
    enabled(async () => {
      const h = harness;
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");

      // Long past the reap window, but this goal has a recorded transaction:
      // the verification pass owns it and the reap must never cut in.
      pastReapWindow(h);
      const summary = await h.scheduler.tick({ now: h.now() });

      expect(summary.results[0].kind).toBe("VERIFIED");
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.lastResult?.outcome).toBe("VERIFIED");
      expect(after.stats.verified).toBe(1);
    }));
});
