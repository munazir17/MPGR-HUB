// Goal state machine + lifecycle tests (spec §8/§24 — Goals).
import { describe, expect, it } from "vitest";

import { canTransitionGoal, GOAL_STATUSES, GOAL_TRANSITIONS, isTerminalGoalStatus } from "@/lib/autonomy/types";
import { InvalidGoalTransitionError, isEvaluatable } from "@/lib/autonomy/goal-machine";
import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { createActiveGoal, makeHarness, WALLET } from "./helpers";

describe("goal transition table", () => {
  it("every status has a defined transition row and terminal rows are empty", () => {
    for (const status of GOAL_STATUSES) {
      expect(Array.isArray(GOAL_TRANSITIONS[status])).toBe(true);
    }
    for (const terminal of ["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"] as const) {
      expect(GOAL_TRANSITIONS[terminal]).toEqual([]);
      expect(isTerminalGoalStatus(terminal)).toBe(true);
    }
  });

  it("allows the full happy lifecycle", () => {
    expect(canTransitionGoal("DRAFT", "ACTIVE")).toBe(true);
    expect(canTransitionGoal("ACTIVE", "WAITING")).toBe(true);
    expect(canTransitionGoal("WAITING", "EXECUTING")).toBe(true);
    expect(canTransitionGoal("EXECUTING", "COMPLETED")).toBe(true);
    expect(canTransitionGoal("ACTIVE", "PAUSED")).toBe(true);
    expect(canTransitionGoal("PAUSED", "ACTIVE")).toBe(true);
    expect(canTransitionGoal("ACTIVE", "CANCELLED")).toBe(true);
    expect(canTransitionGoal("WAITING", "EXPIRED")).toBe(true);
  });

  it("rejects invalid transitions (spec: do not allow an invalid state transition)", () => {
    expect(canTransitionGoal("PAUSED", "EXECUTING")).toBe(false);
    expect(canTransitionGoal("EXECUTING", "PAUSED")).toBe(false);
    expect(canTransitionGoal("EXECUTING", "CANCELLED")).toBe(false);
    expect(canTransitionGoal("COMPLETED", "ACTIVE")).toBe(false);
    expect(canTransitionGoal("CANCELLED", "ACTIVE")).toBe(false);
    expect(canTransitionGoal("EXPIRED", "ACTIVE")).toBe(false);
    expect(canTransitionGoal("FAILED", "ACTIVE")).toBe(false);
    expect(canTransitionGoal("DRAFT", "EXECUTING")).toBe(false);
  });

  it("isEvaluatable covers exactly ACTIVE/WAITING", () => {
    expect(isEvaluatable({ status: "ACTIVE" } as never)).toBe(true);
    expect(isEvaluatable({ status: "WAITING" } as never)).toBe(true);
    expect(isEvaluatable({ status: "PAUSED" } as never)).toBe(false);
    expect(isEvaluatable({ status: "EXECUTING" } as never)).toBe(false);
  });
});

describe("goal store lifecycle (InMemory)", () => {
  it("create -> pause -> resume -> cancel", async () => {
    const harness = makeHarness();
    const { goal } = await createActiveGoal(harness);
    const store = harness.store;

    const paused = await store.transitionGoal(goal.id, WALLET, ["ACTIVE", "WAITING"], goal.updatedAt, {
      status: "PAUSED",
      updatedAt: "t2",
      lastAction: "pause",
    });
    expect(paused?.status).toBe("PAUSED");

    const resumed = await store.transitionGoal(goal.id, WALLET, ["PAUSED"], "t2", {
      status: "ACTIVE",
      updatedAt: "t3",
    });
    expect(resumed?.status).toBe("ACTIVE");

    const cancelled = await store.transitionGoal(goal.id, WALLET, ["ACTIVE"], "t3", {
      status: "CANCELLED",
      updatedAt: "t4",
    });
    expect(cancelled?.status).toBe("CANCELLED");
  });

  it("rejects CAS mismatches and invalid transitions", async () => {
    const harness = makeHarness();
    const { goal } = await createActiveGoal(harness);
    const store = harness.store;

    // stale updatedAt -> null (concurrent writer wins)
    await expect(store.transitionGoal(goal.id, WALLET, ["ACTIVE"], "stale", { status: "PAUSED", updatedAt: "x" })).resolves.toBeNull();
    // wrong wallet -> null
    await expect(store.transitionGoal(goal.id, "0x00000000000000000000000000000000000fffff", ["ACTIVE"], goal.updatedAt, { status: "PAUSED", updatedAt: "x" })).resolves.toBeNull();
    // invalid transition (PAUSED cannot execute) -> throws
    await store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { status: "PAUSED", updatedAt: "p0" });
    await expect(store.transitionGoal(goal.id, WALLET, ["PAUSED"], "p0", { status: "EXECUTING", updatedAt: "x" })).rejects.toBeInstanceOf(InvalidGoalTransitionError);
    // illegal expectedFrom -> null
    await expect(store.transitionGoal(goal.id, WALLET, ["PAUSED"], goal.updatedAt, { updatedAt: "x" })).resolves.toBeNull();
  });

  it("terminal goals cannot be revived", async () => {
    const harness = makeHarness();
    const { goal } = await createActiveGoal(harness);
    const store = harness.store;
    await store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { status: "CANCELLED", updatedAt: "t2" });
    await expect(store.transitionGoal(goal.id, WALLET, ["CANCELLED"], "t2", { status: "ACTIVE", updatedAt: "t3" })).rejects.toBeInstanceOf(InvalidGoalTransitionError);
  });

  it("counts non-terminal goals per wallet", async () => {
    const harness = makeHarness();
    await createActiveGoal(harness);
    await createActiveGoal(harness);
    expect(await harness.store.countNonTerminalGoals(WALLET)).toBe(2);
  });
});
