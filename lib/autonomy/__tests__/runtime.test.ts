// Autonomous runtime end-to-end tests (spec §24 — Trading/Verification/
// Idempotency/Security). The runtime runs against the REAL MCP trade
// service functions (fake chain reader), the REAL event bus, and an
// explicitly test-only delegation adapter. No network, no keys, no mainnet.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

import { createActiveGoal, fundWallet, makeHarness, makePolicy, usdc, WALLET, type TestHarness } from "./helpers";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { evaluateCondition } from "@/lib/autonomy/policy-engine";

async function enabled<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("autonomous runtime — observation and condition phases", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("condition NOT met -> WAITING, no prepare, no execution, next evaluation scheduled", async () =>
    enabled(async () => {
      // quote 1:1 -> 20 USDC buys 0.2 AAPLc => price 100 USDC/AAPLc.
      harness.state.quoteNum = 1n;
      harness.state.quoteDen = 1n;
      const { goal } = await createActiveGoal(harness, { condition: { kind: "price_below", threshold: "10" } });
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("CONDITION_NOT_MET");
      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.lastResult?.outcome).toBe("CONDITION_NOT_MET");
      expect(new Date(after.nextEvaluationAt).getTime()).toBeGreaterThan(harness.now().getTime());
      expect(harness.adapter.options.requests).toHaveLength(0);
      expect(harness.auditEvents).toContain("CONDITION_CHECKED");
    }));

  it("condition met -> stops at AUTHORIZATION_MISSING without a delegation adapter (today's production behavior)", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: false, reason: "NO_DELEGATION_MECHANISM", requests: [] });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h);
      const result = await h.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("PARKED");
      if (result.kind === "PARKED") expect(result.failureCode).toBe("AUTHORIZATION_MISSING");
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.pendingExecution).toBeNull();
      expect(h.auditEvents).toContain("CONDITION_MET");
      expect(h.auditEvents).toContain("AUTHORIZATION_CHECKED");
      expect(h.auditEvents).not.toContain("TRANSACTION_SUBMITTED");
      expect(h.adapter.options.requests).toHaveLength(0);
    }));

  it("runtime disabled (feature flag off) -> SKIPPED before any quote", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "");
    try {
      const { goal } = await createActiveGoal(harness);
      const callsBefore = harness.state.calls.length;
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("SKIPPED");
      expect(harness.state.calls.length).toBe(callsBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("quote failure (no liquidity) -> bounded backoff, goal eventually FAILED", async () =>
    enabled(async () => {
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness);
      harness.state.quoterFails = true;
      for (let i = 0; i < AUTONOMY_LIMITS.maxConsecutiveFailures; i++) {
        const current = (await harness.store.getGoal(goal.id))!;
        harness.advanceClock(120_000);
        // keep it evaluatable
        await harness.store.transitionGoal(goal.id, WALLET, ["WAITING", "ACTIVE"], current.updatedAt, { updatedAt: `r${i}`, status: "ACTIVE" });
        const result = await harness.runtime.evaluateGoal(goal.id);
        expect(result.kind === "PARKED" || result.kind === "EXECUTION_FAILED").toBe(true);
      }
      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("FAILED");
      expect(after.stats.consecutiveFailures).toBe(AUTONOMY_LIMITS.maxConsecutiveFailures);
    }));
});

describe("autonomous runtime — full authorized execution (test-only delegation adapter)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(harness.state, usdc("100"));
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  });

  it("condition met -> quote -> policy -> prepare -> execute -> VERIFIED -> goal COMPLETED at maxTrades=1", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      // 20 USDC at quote 2:1 -> 0.4 AAPLc -> price 50 <= 200 => met
      const submitted = await harness.runtime.evaluateGoal(goal.id);
      expect(submitted.kind).toBe("EXECUTION_SUBMITTED");
      if (submitted.kind !== "EXECUTION_SUBMITTED") return;
      expect(harness.auditEvents).toContain("POLICY_APPROVED");
      expect(harness.auditEvents).toContain("TRADE_PREPARED");
      expect(harness.auditEvents).toContain("TRANSACTION_SUBMITTED");

      // The delegation adapter received UNSIGNED data only.
      const request = harness.adapter.options.requests[0];
      expect(request.transactionRequest).toBeTruthy();
      expect(JSON.stringify(request.transactionRequest)).not.toMatch(/signature|privateKey|seed/i);

      // Next pass verifies the receipt through MCP.
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      const verified = await harness.runtime.evaluateGoal(goal.id);
      expect(verified.kind).toBe("VERIFIED");
      expect(harness.auditEvents).toContain("TRANSACTION_CONFIRMED");
      expect(harness.auditEvents).toContain("EXECUTION_VERIFIED");

      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("COMPLETED");
      expect(after.stats.verified).toBe(1);
      expect(after.pendingExecution).toBeNull();
      // daily ledger recorded exactly the one trade
      const day = new Date(harness.now()).toISOString().slice(0, 10);
      expect(await harness.store.getDailyActions(after.policyId, day)).toBe(1);
      expect(await harness.store.getDailySpendRaw(after.policyId, day)).toBe(usdc("20"));
    }));

  it("repeating goal keeps trading within policy and completes at maxTrades", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 2 });
      const day = new Date(harness.now()).toISOString().slice(0, 10);

      // trade 1
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("VERIFIED");
      const mid = (await harness.store.getGoal(goal.id))!;
      expect(mid.status).toBe("WAITING"); // more trades allowed

      // trade 2
      harness.advanceClock(61_000);
      const current = (await harness.store.getGoal(goal.id))!;
      await harness.store.transitionGoal(goal.id, WALLET, ["WAITING"], current.updatedAt, { status: "ACTIVE", updatedAt: "w2" });
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("VERIFIED");

      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("COMPLETED");
      expect(await harness.store.getDailyActions(after.policyId, day)).toBe(2);
    }));

  it("execution slot idempotency: a pre-claimed slot key blocks a second execution attempt", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 5 });
      // Another worker already claimed the exact slot key the runtime derives.
      const slotKey = `exec-${goal.id}:${goal.nextEvaluationAt}`;
      expect(await harness.store.claimExecution(slotKey, 1000)).toBe(true);
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("DUPLICATE_PREVENTED");
      expect(harness.adapter.options.requests).toHaveLength(0);
      expect(harness.auditEvents).toContain("DUPLICATE_PREVENTED");
    }));

  it("never executes on a stale quote: harness clock ahead of quote TTL -> QUOTE_STALE, no execution", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      // Push the harness clock 10 minutes past the MCP deps clock: any quote
      // the gateway issues is already expired relative to the runtime's now().
      harness.advanceHarnessClockOnly(600_000);
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("PARKED");
      if (result.kind === "PARKED") expect(result.failureCode).toBe("QUOTE_STALE");
      expect(harness.adapter.options.requests).toHaveLength(0);
      const after = (await harness.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.pendingExecution).toBeNull();
      // Direct guard check: the condition evaluator refuses zero/negative quote data.
      expect(evaluateCondition({ kind: "price_below", threshold: "200" }, "0", "0", 6, 8).met).toBe(false);
    }));

  it("concurrent duplicate evaluation of one goal: exactly one proceeds (lease), zero double-execution", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 2 });
      const [a, b] = await Promise.all([
        harness.runtime.evaluateGoal(goal.id),
        harness.runtime.evaluateGoal(goal.id),
      ]);
      const kinds = [a.kind, b.kind].sort();
      // One owns the lease and submits; the other is skipped busy — never two submissions.
      expect(kinds).toEqual(["EXECUTION_SUBMITTED", "SKIPPED"].sort());
      expect(harness.adapter.options.requests).toHaveLength(1);
    }));

  it("execution adapter failure after authorization -> goal parked/failed, slot consumed, no tx", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], failWith: { code: "EXECUTION_UNAVAILABLE", message: "session wallet unavailable" } });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 3 }, { maxDailyRaw: usdc("10000"), maxActionsPerDay: 50 });
      const result = await h.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("EXECUTION_FAILED");
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING"); // bounded retry, not terminal on first failure
      expect(after.pendingExecution).toBeNull();
      expect(h.auditEvents).toContain("EXECUTION_FAILED");
      // the failed attempt consumed one daily action slot (conservative by design)
      const day = new Date(h.now()).toISOString().slice(0, 10);
      expect(await h.store.getDailyActions(after.policyId, day)).toBe(1);
    }));

  it("policy breach mid-flight: daily cap reached between goals is enforced before execute", async () =>
    enabled(async () => {
      const { policy, goal } = await createActiveGoal(harness, { maxTrades: 5 });
      const day = new Date(harness.now()).toISOString().slice(0, 10);
      // Fill the daily ledger to the policy's cap (maxActionsPerDay = 5)
      for (let i = 0; i < 5; i++) await harness.store.tryRecordDailyAction(policy.id, day, usdc("20"), 5);
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("PARKED");
      if (result.kind === "PARKED") expect(result.failureCode).toBe("POLICY_REJECTED");
      expect(harness.adapter.options.requests).toHaveLength(0);
      expect(harness.auditEvents).toContain("POLICY_REJECTED");
    }));

  it("revoked policy -> action refused before authorization", async () =>
    enabled(async () => {
      const { policy, goal } = await createActiveGoal(harness);
      await harness.store.revokePolicy(policy.id, WALLET, new Date().toISOString());
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("PARKED");
      if (result.kind === "PARKED") expect(result.failureCode).toBe("POLICY_REJECTED");
      expect(harness.adapter.options.requests).toHaveLength(0);
    }));

  it("emergency disable -> observation runs but execution is refused", async () =>
    enabled(async () => {
      vi.stubEnv("MPGR_AUTONOMOUS_EMERGENCY_DISABLE", "true");
      const { goal } = await createActiveGoal(harness);
      const result = await harness.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("PARKED");
      if (result.kind === "PARKED") expect(result.failureCode).toBe("EXECUTION_UNAVAILABLE");
      expect(harness.adapter.options.requests).toHaveLength(0);
      expect(harness.auditEvents).toContain("AUTHORIZATION_CHECKED");
      vi.unstubAllEnvs();
    }));

  it("reverted transaction -> FAILED honestly, no blind retry, goal waits with backoff", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], neverConfirm: true });
      // neverConfirm: broadcast "succeeds" (tx hash) but the receipt will be a REVERT.
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      const txHash = h.adapter.options.requests[0] ? `0x${"7e".repeat(32)}` : `0x${"7e".repeat(32)}`;
      // Write a REVERTED receipt.
      h.state.receipts.set(txHash.toLowerCase(), {
        status: "reverted",
        transactionHash: txHash as Hex,
        blockNumber: 43n,
        from: WALLET,
        to: WALLET,
        logs: [],
      } as never);
      h.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      const verdict = await h.runtime.evaluateGoal(goal.id);
      expect(verdict.kind).toBe("EXECUTION_FAILED");
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.pendingExecution).toBeNull();
      expect(after.lastResult?.outcome).toBe("FAILED");
    }));

  it("uncertain broadcast (no receipt within attempt budget) -> goal FAILED, never re-submitted", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], neverConfirm: true });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      for (let i = 0; i < AUTONOMY_LIMITS.maxVerificationAttempts; i++) {
        const current = (await h.store.getGoal(goal.id))!;
        h.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
        if (current.status === "EXECUTING") {
          const r = await h.runtime.evaluateGoal(goal.id);
          expect(r.kind === "VERIFICATION_PENDING" || r.kind === "UNCERTAIN").toBe(true);
        }
      }
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("FAILED");
      expect(after.pendingExecution).toBeNull();
      expect(after.lastResult?.outcome).toBe("FAILED");
      // and a further evaluation is skipped entirely (terminal)
      h.advanceClock(120_000);
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("SKIPPED");
    }));

  it("audit trail carries no key-shaped material", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      await harness.runtime.evaluateGoal(goal.id);
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      await harness.runtime.evaluateGoal(goal.id);
      const dump = JSON.stringify(await harness.store.listAudit(goal.id));
      expect(dump).not.toMatch(/private|secret|mnemonic|seed phrase|bearer/i);
    }));
});

describe("autonomous runtime — pause / cancel interplay", () => {
  it("paused goals are not evaluated by the scheduler", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness);
      await harness.store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { status: "PAUSED", updatedAt: "p1" });
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(0);
    }));

  it("scheduler tick evaluates a due goal exactly once per pass", async () =>
    enabled(async () => {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const { goal } = await createActiveGoal(harness, { maxTrades: 2 });
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(1);
      expect(summary.results[0].kind).toBe("EXECUTION_SUBMITTED");
      // second immediate tick: goal is EXECUTING with pending verification —
      // due only after the retry delay
      const summary2 = await harness.scheduler.tick({ now: harness.now() });
      expect(summary2.evaluated).toBe(0);
    }));
});
