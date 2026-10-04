// lib/autonomy/__tests__/hardening-policy-goals.test.ts
//
// PHASE 4 HARDENING — policy boundaries incl. exact limit±1 (§9), exhaustive
// goal state-machine transitions (§10) and audit/event integrity (§15).
// All integer arithmetic for financial values; deterministic clocks.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getAddress, type Address } from "viem";

import { evaluatePolicyAgainstAction, type ProposedAction } from "@/lib/autonomy/policy-engine";
import { requireTransition, InvalidGoalTransitionError } from "@/lib/autonomy/goal-machine";
import { GOAL_TRANSITIONS, canTransitionGoal, type AutonomyPolicy, type GoalStatus } from "@/lib/autonomy/types";
import { makeHarness, createActiveGoal, fundWallet, usdc, WALLET, type TestHarness } from "./helpers";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";

const NOW = new Date("2026-10-01T00:00:00Z");
const USER = getAddress("0x0000000000000000000000000000000000000001") as Address;
const SELL = getAddress("0x00000000000000000000000000000000000000a5") as Address;
const BUY = getAddress("0x00000000000000000000000000000000000000b7") as Address;

function makePolicy(over: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    id: "pol-b",
    wallet: USER,
    chainId: 8453,
    actions: ["swap"],
    sellToken: SELL,
    buyToken: BUY,
    maxPerTradeRaw: "1000",
    maxDailyRaw: "2000",
    maxSlippageBps: 100,
    maxActionsPerDay: 2,
    enabled: true,
    createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    authorizedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    authorizationRef: "b",
    ...over,
  };
}

const GOAL = { expiresAt: new Date(NOW.getTime() + 3600_000).toISOString() };

function action(over: Partial<ProposedAction> = {}): ProposedAction {
  return { action: "swap", chainId: 8453, sellToken: SELL, buyToken: BUY, sellAmountRaw: "500", slippageBps: 50, ...over };
}

describe("hardening: policy boundaries — exact integer limit±1 (§9)", () => {
  const base = { spend: { dailySpendRaw: "0", actionsToday: 0 } };

  it("per-trade limit: limit-1 allowed, limit allowed, limit+1 rejected", () => {
    const p = makePolicy();
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "999" }), base.spend, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "1000" }), base.spend, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "1001" }), base.spend, NOW).allowed).toBe(false);
  });

  it("daily cap: cumulative integer math, exact boundary allowed, boundary+1 rejected", () => {
    const p = makePolicy({ maxDailyRaw: "2000" });
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "1000" }), { dailySpendRaw: "999", actionsToday: 0 }, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "1000" }), { dailySpendRaw: "1000", actionsToday: 0 }, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "1000" }), { dailySpendRaw: "1001", actionsToday: 0 }, NOW).allowed).toBe(false);
    // BigInt semantics: no float drift near 2^53
    const big = makePolicy({ maxPerTradeRaw: "9007199254740993", maxDailyRaw: "18014398509481986" });
    expect(evaluatePolicyAgainstAction(big, GOAL, action({ sellAmountRaw: "9007199254740993" }), { dailySpendRaw: "0", actionsToday: 0 }, NOW).allowed).toBe(true);
  });

  it("slippage limit: exact boundary allowed, boundary+1 rejected", () => {
    const p = makePolicy({ maxSlippageBps: 100 });
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ slippageBps: 99 }), base.spend, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ slippageBps: 100 }), base.spend, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ slippageBps: 101 }), base.spend, NOW).allowed).toBe(false);
  });

  it("action-rate limit: N-1 allowed, N allowed, N+1 rejected", () => {
    const p = makePolicy({ maxActionsPerDay: 2 });
    expect(evaluatePolicyAgainstAction(p, GOAL, action(), { dailySpendRaw: "0", actionsToday: 0 }, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action(), { dailySpendRaw: "0", actionsToday: 1 }, NOW).allowed).toBe(true);
    expect(evaluatePolicyAgainstAction(p, GOAL, action(), { dailySpendRaw: "0", actionsToday: 2 }, NOW).allowed).toBe(false);
  });

  it("token/chain/action restrictions and expiry hold at the boundaries", () => {
    const p = makePolicy();
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellToken: BUY, buyToken: SELL }), base.spend, NOW).allowed).toBe(false);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ chainId: 84532 }), base.spend, NOW).allowed).toBe(false);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ action: "transfer" as never }), base.spend, NOW).allowed).toBe(false);
    // expiry edge: expiresAt == now -> expired
    const edge = makePolicy({ expiresAt: NOW.toISOString() });
    expect(evaluatePolicyAgainstAction(edge, GOAL, action(), base.spend, NOW).allowed).toBe(false);
    // goal expiry edge
    const goalEdge = { expiresAt: NOW.toISOString() };
    expect(evaluatePolicyAgainstAction(p, goalEdge, action(), base.spend, NOW).allowed).toBe(false);
    // revoked / disabled
    expect(evaluatePolicyAgainstAction(makePolicy({ revokedAt: NOW.toISOString() } as never), GOAL, action(), base.spend, NOW).allowed).toBe(false);
    expect(evaluatePolicyAgainstAction(makePolicy({ enabled: false }), GOAL, action(), base.spend, NOW).allowed).toBe(false);
    // zero / malformed amounts rejected before limit logic
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "0" }), base.spend, NOW).allowed).toBe(false);
    expect(evaluatePolicyAgainstAction(p, GOAL, action({ sellAmountRaw: "12.5" }), base.spend, NOW).allowed).toBe(false);
  });
});

const ALL_STATUSES: GoalStatus[] = ["DRAFT", "ACTIVE", "PAUSED", "WAITING", "EXECUTING", "COMPLETED", "FAILED", "EXPIRED", "CANCELLED"];

describe("hardening: goal state machine — exhaustive transition matrix (§10)", () => {
  it("every legal transition is accepted and every illegal one rejected", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const legal = GOAL_TRANSITIONS[from].includes(to);
        if (from === to) continue; // no-op writes allowed by design
        if (legal) {
          expect(() => requireTransition(from, to), `${from}->${to} must be legal`).not.toThrow();
        } else {
          expect(() => requireTransition(from, to), `${from}->${to} must be ILLEGAL`).toThrow(InvalidGoalTransitionError);
        }
        expect(canTransitionGoal(from, to)).toBe(legal);
      }
    }
  });

  it("terminal states have no outgoing transitions", () => {
    for (const t of ["COMPLETED", "FAILED", "EXPIRED", "CANCELLED"] as GoalStatus[]) {
      expect(GOAL_TRANSITIONS[t]).toEqual([]);
    }
  });

  it("restart recovery: a goal mid-EXECUTING can only return to live states, never complete twice", async () => {
    // EXECUTING -> COMPLETED is legal exactly once (terminal afterwards).
    expect(GOAL_TRANSITIONS.EXECUTING).toEqual(["ACTIVE", "WAITING", "COMPLETED", "FAILED", "EXPIRED"]);
    expect(GOAL_TRANSITIONS.COMPLETED).toEqual([]);
  });
});

describe("hardening: audit/event integrity (§15)", () => {
  let harness: TestHarness;
  const payloads: Array<Record<string, unknown>> = [];
  let savedFlag: string | undefined;

  beforeEach(async () => {
    payloads.length = 0;
    savedFlag = process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
    process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = "true";
    harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(harness.state, usdc("100"));
    harness.bus.on("autonomy_audit", (payload: unknown) => payloads.push(payload as Record<string, unknown>));
    await createActiveGoal(harness, { maxTrades: 1 });
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.MPGR_AUTONOMOUS_AGENT_ENABLED;
    else process.env.MPGR_AUTONOMOUS_AGENT_ENABLED = savedFlag;
  });

  it("lifecycle emits the full ordered event set on success, with no secrets in payloads", async () => {
    const g0 = (await harness.store.listGoals(WALLET))[0]!;
    // pass 1: condition -> quote -> policy -> broadcast (TRANSACTION_SUBMITTED)
    await harness.runtime.evaluateGoal(g0.id);
    // pass 2 (after verification backoff): receipt verification (EXECUTION_VERIFIED)
    harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
    await harness.runtime.evaluateGoal(g0.id);

    const types = payloads.map((p) => String((p as { event?: { type?: string } }).event?.type));
    for (const expected of ["CONDITION_CHECKED", "QUOTE_CREATED", "TRANSACTION_SUBMITTED", "EXECUTION_VERIFIED"]) {
      expect(types, `missing ${expected}; got ${types.join(",")}`).toContain(expected);
    }
    // ordering: quote before submit before verified
    expect(types.indexOf("QUOTE_CREATED")).toBeLessThan(types.indexOf("TRANSACTION_SUBMITTED"));
    expect(types.indexOf("TRANSACTION_SUBMITTED")).toBeLessThan(types.indexOf("EXECUTION_VERIFIED"));
    // no key material / signatures / long hex secrets in ANY payload
    const dumped = JSON.stringify(payloads);
    expect(dumped).not.toMatch(/privateKey|PRIVATE_KEY|seed phrase|mnemonic/i);
    expect(dumped).not.toMatch(/0x[a-fA-F0-9]{130}/); // 65-byte signatures
  });

  it("terminal failure path is audited (GOAL_FAILED) and never reports success", async () => {
    harness.state.quoterFails = true;
    const goal = (await harness.store.listGoals(WALLET))[0]!;
    for (let i = 0; i < AUTONOMY_LIMITS.maxConsecutiveFailures; i++) {
      const current = (await harness.store.getGoal(goal.id))!;
      harness.advanceClock(120_000);
      if ((await harness.store.getGoal(goal.id))!.status === "WAITING") {
        await harness.store.transitionGoal(goal.id, WALLET, ["WAITING", "ACTIVE"], current.updatedAt, { updatedAt: `r${i}`, status: "ACTIVE" });
      }
      await harness.runtime.evaluateGoal(goal.id);
    }
    const types = payloads.map((p) => String((p as { event?: { type?: string } }).event?.type));
    expect(types, "terminal failure must be audited").toContain("GOAL_FAILED");
    expect(types).not.toContain("EXECUTION_VERIFIED");
    expect(types).not.toContain("TRANSACTION_SUBMITTED");
  });
});
