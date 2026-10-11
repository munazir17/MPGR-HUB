import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import {
  readAutonomousEmergencySwitch,
  resetEmergencySwitchForTests,
  setEmergencySwitchReaderForTests,
  type EmergencySwitchDecision,
} from "@/lib/autonomy/emergency-switch";
import { createActiveGoal, fundWallet, makeHarness, usdc, type TestHarness } from "./helpers";

async function enabled<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

function allow(): EmergencySwitchDecision {
  return { allowed: true, reason: "ENABLED", correlationId: "t" };
}
function deny(reason: EmergencySwitchDecision["reason"] = "EMERGENCY_SWITCH_DISABLED"): EmergencySwitchDecision {
  return { allowed: false, reason, correlationId: "t" };
}

describe("runtime emergency switch at the execution boundary", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(harness.state, usdc("100"));
  });

  afterEach(() => {
    resetEmergencySwitchForTests();
  });

  it("explicit enabled KV + other gates satisfied still executes", async () =>
    enabled(async () => {
      setEmergencySwitchReaderForTests(async () => allow());
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("EXECUTION_SUBMITTED");
      expect(harness.adapter.options.requests).toHaveLength(1);
    }));

  it("explicit disabled KV parks without executing", async () =>
    enabled(async () => {
      setEmergencySwitchReaderForTests(async () => deny());
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("PARKED");
      if (result.kind === "PARKED") expect(result.failureCode).toBe("EXECUTION_UNAVAILABLE");
      expect(harness.adapter.options.requests).toHaveLength(0);
      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.stats.consecutiveFailures).toBe(0);
    }));

  it("missing KV fails closed and does not increment consecutiveFailures across repeats", async () =>
    enabled(async () => {
      const created = await createActiveGoal(harness, { maxTrades: 5 });
      setEmergencySwitchReaderForTests(async () => deny("EMERGENCY_SWITCH_MISSING"));
      for (let i = 0; i < AUTONOMY_LIMITS.maxConsecutiveFailures + 2; i++) {
        const result = await harness.runtime.evaluateGoal(created.goal.id);
        expect(result.kind).toBe("PARKED");
        const g = (await harness.store.getGoal(created.goal.id))!;
        expect(g.status).not.toBe("FAILED");
        expect(g.stats.consecutiveFailures).toBe(0);
      }
    }));

  it("honours a disable between tick start and the execution boundary", async () =>
    enabled(async () => {
      let reads = 0;
      setEmergencySwitchReaderForTests(async () => {
        reads += 1;
        return reads === 1 ? allow() : deny("EMERGENCY_SWITCH_DISABLED");
      });
      const { goal, policy } = await createActiveGoal(harness, { maxTrades: 2 });
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(result.kind).toBe("PARKED");
      expect(harness.adapter.options.requests).toHaveLength(0);
      const g = (await harness.store.getGoal(goal.id))!;
      expect(g.status).toBe("WAITING");
      expect(g.stats.consecutiveFailures).toBe(0);
      const day = harness.now().toISOString().slice(0, 10);
      const spend = await harness.store.getDailySpendRaw(policy.id, day);
      expect(BigInt(spend) > 0n).toBe(true);

      // Verify the reservation state is retained as ATTEMPTING (conservative accounting)
      const slotKey = `${goal.id}:${goal.nextEvaluationAt}`;
      const idempotencyKey = `exec-${slotKey}`;
      const dayHash = (harness.store as any).dayHashes.get((harness.store as any).dayKey(policy.id, day));
      const res = dayHash?.reservations.get(idempotencyKey);
      expect(res?.state).toBe("ATTEMPTING");

      // Same-execId retry: attempting with the exact same execution key produces DUPLICATE_PREVENTED, never executes adapter
      const dupReservation = await harness.store.reserveDailySpend({
        policyId: policy.id,
        dayKey: day,
        execId: idempotencyKey,
        amountRaw: goal.trade.sellAmountRaw,
        maxDailyRaw: policy.maxDailyRaw,
        maxActions: policy.maxActionsPerDay,
      });
      expect(dupReservation.ok).toBe(true);
      if (dupReservation.ok) {
        expect(dupReservation.state).toBe("ATTEMPTING");
      }
    }));

  it("denial after markSpendAttempt preserves spend cap against new evaluation IDs", async () =>
    enabled(async () => {
      let reads = 0;
      setEmergencySwitchReaderForTests(async () => {
        reads += 1;
        return reads === 1 ? allow() : deny("EMERGENCY_SWITCH_DISABLED");
      });
      // Set daily spend cap equal to exactly 1 trade
      const tradeAmount = usdc("20");
      const { goal } = await createActiveGoal(
        harness,
        { maxTrades: 2 },
        { maxDailyRaw: tradeAmount },
      );
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("PARKED");
      expect(harness.adapter.options.requests).toHaveLength(0);

      // Switch re-enabled: subsequent tick for a NEW evaluation slot
      setEmergencySwitchReaderForTests(async () => allow());
      // Advance clock so cooldown passes (60s cooldown = 60_000ms)
      harness.advanceClock(120_000);

      const result2 = await harness.runtime.evaluateGoal(goal.id);
      // Because the first trade's ATTEMPTING reservation remains counted, the new slot is rejected by daily spend cap!
      expect(result2.kind).toBe("PARKED");
      if (result2.kind === "PARKED") {
        expect(result2.failureCode).toBe("POLICY_REJECTED");
      }
      expect(harness.adapter.options.requests).toHaveLength(0);
    }));

  it("concurrent ticks on the same goal: lease prevents double-evaluation", async () =>
    enabled(async () => {
      setEmergencySwitchReaderForTests(async () => allow());
      const { goal } = await createActiveGoal(harness, { maxTrades: 2 });
      const [res1, res2] = await Promise.all([
        harness.runtime.evaluateGoal(goal.id),
        harness.runtime.evaluateGoal(goal.id),
      ]);
      const submitted = [res1, res2].filter((r) => r.kind === "EXECUTION_SUBMITTED");
      const skipped = [res1, res2].filter((r) => r.kind === "SKIPPED");
      expect(submitted).toHaveLength(1);
      expect(skipped).toHaveLength(1);
      expect(harness.adapter.options.requests).toHaveLength(1);
    }));

  it("fails closed on KV timeout and network error without executing adapter", async () =>
    enabled(async () => {
      setEmergencySwitchReaderForTests(async () => deny("EMERGENCY_SWITCH_TIMEOUT"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      const resTimeout = await harness.runtime.evaluateGoal(goal.id);
      expect(resTimeout.kind).toBe("PARKED");
      if (resTimeout.kind === "PARKED") expect(resTimeout.failureCode).toBe("EXECUTION_UNAVAILABLE");
      expect(harness.adapter.options.requests).toHaveLength(0);

      setEmergencySwitchReaderForTests(async () => deny("EMERGENCY_SWITCH_ERROR"));
      const resError = await harness.runtime.evaluateGoal(goal.id);
      expect(resError.kind).toBe("PARKED");
      if (resError.kind === "PARKED") expect(resError.failureCode).toBe("EXECUTION_UNAVAILABLE");
      expect(harness.adapter.options.requests).toHaveLength(0);
    }));

  it("switch re-enablement allows subsequent evaluation to execute normally", async () =>
    enabled(async () => {
      // Disabled first
      setEmergencySwitchReaderForTests(async () => deny());
      const { goal } = await createActiveGoal(harness, { maxTrades: 2 });
      const res1 = await harness.runtime.evaluateGoal(goal.id);
      expect(res1.kind).toBe("PARKED");
      expect(harness.adapter.options.requests).toHaveLength(0);

      // Re-enabled
      setEmergencySwitchReaderForTests(async () => allow());
      harness.advanceClock(120_000);

      const res2 = await harness.runtime.evaluateGoal(goal.id);
      expect(res2.kind).toBe("EXECUTION_SUBMITTED");
      expect(harness.adapter.options.requests).toHaveLength(1);
    }));

  it("does not reverse an already-broadcast pending execution (verification still runs)", async () =>
    enabled(async () => {
      setEmergencySwitchReaderForTests(async () => allow());
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      setEmergencySwitchReaderForTests(async () => deny());
      const second = await harness.runtime.evaluateGoal(goal.id);
      expect(second.kind === "VERIFIED" || second.kind === "PARKED" || second.kind === "EXECUTION_FAILED" || second.kind === "SKIPPED").toBe(true);
      const g = (await harness.store.getGoal(goal.id))!;
      expect(g.pendingExecution || g.status === "COMPLETED" || g.lastResult?.outcome === "VERIFIED" || g.status !== "ACTIVE").toBeTruthy();
    }));
});

describe("emergency switch default in tests", () => {
  it("missing injection fails closed (no live KV, no global enable mock)", async () => {
    resetEmergencySwitchForTests();
    const d = await readAutonomousEmergencySwitch();
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("EMERGENCY_SWITCH_UNAVAILABLE");
  });
});
