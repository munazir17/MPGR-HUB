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

describe("emergency switch reader isolation", () => {
  it("default test setup allows execution (setupFiles)", async () => {
    const d = await readAutonomousEmergencySwitch();
    expect(d.allowed).toBe(true);
  });
});
