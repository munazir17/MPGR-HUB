// lib/autonomy/__tests__/post-executing-budget.test.ts
//
// Pins the tick time budget to the platform limit it depends on. The runtime's
// behavior under a hung broadcast is proven in mainnet-delegated-execution.test.ts
// ("post-EXECUTING budget" block). These checks keep the numbers consistent:
// if someone raises the budget toward maxDuration again, this fails.
//
// Production evidence behind the numbers: with maxDuration = 120 and a 110 s
// budget, the platform still killed a tick at ~60 s and the goal fell through
// to the stuck-execution reap. So the budget is anchored at 45 s after tick
// start against the OBSERVED 60 s kill — never against maxDuration.

import { describe, expect, it } from "vitest";

import { maxDuration } from "@/app/api/agent/autonomy/tick/route";
import {
  AUTONOMY_EXECUTION_BUDGET_SECONDS,
  AUTONOMY_LIMITS,
  AUTONOMY_MIN_EXECUTION_BUDGET_SECONDS,
  AUTONOMY_PLATFORM_KILL_SECONDS,
  AUTONOMY_TICK_MAX_DURATION_SECONDS,
  AUTONOMY_TICK_PERSIST_RESERVE_SECONDS,
} from "@/lib/autonomy/config";
import { STUCK_EXECUTION_REAP_SECONDS } from "@/lib/autonomy/types";

describe("tick time budget (post-EXECUTING work)", () => {
  it("the tick route's maxDuration is the documented constant (unchanged — raising it is not the fix)", () => {
    expect(maxDuration).toBe(AUTONOMY_TICK_MAX_DURATION_SECONDS);
    expect(AUTONOMY_TICK_MAX_DURATION_SECONDS).toBe(120);
  });

  it("post-EXECUTING work ends exactly 45 s after tick start", () => {
    expect(AUTONOMY_EXECUTION_BUDGET_SECONDS).toBe(45);
  });

  it("the persist reserve fills the gap to the observed 60 s platform kill, not to maxDuration", () => {
    expect(AUTONOMY_PLATFORM_KILL_SECONDS).toBe(60);
    expect(AUTONOMY_EXECUTION_BUDGET_SECONDS + AUTONOMY_TICK_PERSIST_RESERVE_SECONDS).toBe(AUTONOMY_PLATFORM_KILL_SECONDS);
    // A full Redis save window remains between the budget end and the kill.
    expect(AUTONOMY_TICK_PERSIST_RESERVE_SECONDS).toBeGreaterThanOrEqual(10);
    // The budget must end well before even a platform-capped (60 s) invocation dies.
    expect(AUTONOMY_EXECUTION_BUDGET_SECONDS).toBeLessThan(AUTONOMY_PLATFORM_KILL_SECONDS);
    expect(AUTONOMY_EXECUTION_BUDGET_SECONDS).toBeLessThanOrEqual(maxDuration - 10);
  });

  it("the minimum budget needed to start a broadcast fits inside the budget", () => {
    expect(AUTONOMY_MIN_EXECUTION_BUDGET_SECONDS).toBeGreaterThan(0);
    expect(AUTONOMY_MIN_EXECUTION_BUDGET_SECONDS).toBeLessThan(AUTONOMY_EXECUTION_BUDGET_SECONDS);
  });

  it("the budget ends before the evaluation lease and the stuck-execution reap can fire", () => {
    // The lease and the reap both count from the evaluation start, which is never
    // later than the tick start the budget is anchored to.
    expect(AUTONOMY_EXECUTION_BUDGET_SECONDS).toBeLessThan(AUTONOMY_LIMITS.evaluationLeaseSeconds);
    expect(AUTONOMY_EXECUTION_BUDGET_SECONDS).toBeLessThan(STUCK_EXECUTION_REAP_SECONDS);
  });
});
