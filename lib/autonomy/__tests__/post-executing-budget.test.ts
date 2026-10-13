// lib/autonomy/__tests__/post-executing-budget.test.ts
//
// Pins the tick time budget to the platform limit it depends on. The runtime's
// behavior under a hung broadcast is proven in mainnet-delegated-execution.test.ts
// ("post-EXECUTING budget" block). These checks keep the numbers consistent:
// if someone lowers maxDuration or raises the budget, this fails.

import { describe, expect, it } from "vitest";

import { maxDuration } from "@/app/api/agent/autonomy/tick/route";
import {
  AUTONOMY_EXECUTION_BUDGET_SECONDS,
  AUTONOMY_LIMITS,
  AUTONOMY_MIN_EXECUTION_BUDGET_SECONDS,
  AUTONOMY_TICK_MAX_DURATION_SECONDS,
  AUTONOMY_TICK_PERSIST_RESERVE_SECONDS,
} from "@/lib/autonomy/config";
import { STUCK_EXECUTION_REAP_SECONDS } from "@/lib/autonomy/types";

describe("tick time budget (post-EXECUTING work)", () => {
  it("the tick route's maxDuration is the documented constant", () => {
    expect(maxDuration).toBe(AUTONOMY_TICK_MAX_DURATION_SECONDS);
  });

  it("post-EXECUTING work ends at least 10 s before the tick's maxDuration", () => {
    expect(AUTONOMY_TICK_PERSIST_RESERVE_SECONDS).toBeGreaterThanOrEqual(10);
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
