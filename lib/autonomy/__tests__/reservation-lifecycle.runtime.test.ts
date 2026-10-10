// Runtime-level spend-reservation lifecycle tests (R5 + failure classification).
//
// Verifies the exact commit/release/ambiguous decision the runtime makes at
// every failure point of the ACT path, that the attempt marker is persisted
// BEFORE the execution adapter is invoked, that unknown outcomes never free
// spend, and that switch refusals / infrastructure outages never increment
// the trade-failure counter or permanently fail an active goal.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import { AutonomyRuntime } from "@/lib/autonomy/runtime";
import { BusAuditSink } from "@/lib/autonomy/audit";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import type { McpGateway } from "@/lib/autonomy/mcp-gateway";
import {
  createActiveGoal,
  fundWallet,
  makeHarness,
  silentLogger,
  usdc,
  type TestHarness,
} from "./helpers";

function dayOf(h: TestHarness): string {
  return new Date(h.now()).toISOString().slice(0, 10);
}

/** Advance past the verification retry window (receipt checks become due). */
function harnessAdvance(h: TestHarness): void {
  h.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
}

function enabled<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  return fn().finally(() => vi.unstubAllEnvs());
}

describe("runtime spend reservations — commit/release/ambiguous decisions", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(harness.state, usdc("100"));
  });

  it("successful execution -> reservation COMMITTED at submit (stays counted through revert-less verification)", async () =>
    enabled(async () => {
      const { goal } = await createActiveGoal(harness, { maxTrades: 1 });
      expect((await harness.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      const day = dayOf(harness);
      const reservations = harness.store.dayHashes.get(`${goal.policyId}:${day}`)!.reservations;
      expect([...reservations.values()].map((r) => r.state)).toEqual(["COMMITTED"]);
      expect(await harness.store.getDayLedger(goal.policyId, day)).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    }));

  it("reverted execution -> spend STAYS counted (gas was spent; conservative)", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], neverConfirm: true });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      const day = dayOf(h);
      // Committed at submit time…
      expect(await h.store.getDayLedger(goal.policyId, day)).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
      // …and a REVERTED receipt never frees it.
      const txHash = `0x${"7e".repeat(32)}` as `0x${string}`;
      h.state.receipts.set(txHash.toLowerCase(), {
        status: "reverted",
        transactionHash: txHash,
        blockNumber: 43n,
        from: "0x0000000000000000000000000000000000d0e541",
        to: "0x0000000000000000000000000000000000d0e541",
        logs: [],
      } as never);
      harnessAdvance(h);
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_FAILED");
      expect(await h.store.getDayLedger(goal.policyId, day)).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    }));

  it("verified pre-broadcast refusal codes release the reservation (spot-check)", async () =>
    enabled(async () => {
      for (const code of ["POLICY_REJECTED", "TOKEN_NOT_ALLOWED", "MCP_DISABLED"] as const) {
        const h = makeHarness({ authorized: true, requests: [], failWith: { code, message: `refused ${code}` } });
        fundWallet(h.state, usdc("100"));
        const { goal } = await createActiveGoal(h, { maxTrades: 1 });
        expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_FAILED");
        expect(await h.store.getDayLedger(goal.policyId, dayOf(h))).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
      }
    }));

  it("adapter throw -> AMBIGUOUS, spend never released, message discloses unknown outcome", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [] });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      h.adapter.executeSwap = () => Promise.reject(new Error("socket hang up"));
      const result = await h.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("EXECUTION_FAILED");
      const day = dayOf(h);
      const res = h.store.dayHashes.get(`${goal.policyId}:${day}`)!.reservations;
      expect([...res.values()].map((r) => r.state)).toEqual(["AMBIGUOUS"]);
      expect(await h.store.getDayLedger(goal.policyId, day)).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    }));

  it("adapter RPC_ERROR (broadcast may have landed) -> AMBIGUOUS, spend never released", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], failWith: { code: "RPC_ERROR", message: "broadcast outcome unknown" } });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_FAILED");
      const day = dayOf(h);
      const res = h.store.dayHashes.get(`${goal.policyId}:${day}`)!.reservations;
      expect([...res.values()].map((r) => r.state)).toEqual(["AMBIGUOUS"]);
    }));

  it("attempt marker is persisted BEFORE the adapter is invoked (crash window proof)", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      const order: string[] = [];
      const realMark = h.store.markSpendAttempt.bind(h.store);
      h.store.markSpendAttempt = async (...args) => {
        order.push("mark");
        return realMark(...args);
      };
      const realExecute = h.adapter.executeSwap.bind(h.adapter);
      h.adapter.executeSwap = (req) => {
        order.push("execute");
        // INSIDE the adapter call the attempt marker must already be visible.
        const res = h.store.dayHashes.get(`${goal.policyId}:${dayOf(h)}`)!.reservations;
        expect([...res.values()].map((r) => r.state)).toEqual(["ATTEMPTING"]);
        return realExecute(req);
      };
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_SUBMITTED");
      expect(order).toEqual(["mark", "execute"]);
    }));

  it("attempt-marker Redis failure -> adapter NEVER invoked, reservation stays RESERVED (recoverable), no trade-failure counted", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      h.store.markSpendAttempt = () => Promise.resolve(null); // lost response
      const result = await h.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("EXECUTION_FAILED");
      expect(h.adapter.options.requests).toHaveLength(0); // ONE-BROADCAST SAFETY
      const day = dayOf(h);
      const res = h.store.dayHashes.get(`${goal.policyId}:${day}`)!.reservations;
      expect([...res.values()].map((r) => r.state)).toEqual(["RESERVED"]);
      const after = (await h.store.getGoal(goal.id))!;
      // RPC_ERROR is an infrastructure code: no trade-failure increment…
      expect(after.stats.consecutiveFailures).toBe(0);
      // …and the stuck RESERVED entry is recoverable via the verified path.
      expect(await h.store.releaseDailySpend(goal.policyId, day, `exec-${goal.id}:${goal.nextEvaluationAt}`, { reason: "UNATTEMPTED" })).toBe("RELEASED");
    }));

  it("reserve-time Redis failure -> evaluation FAILS CLOSED (throws), adapter never invoked", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      h.store.reserveDailySpend = () => Promise.reject(new Error("redis down"));
      await expect(h.runtime.evaluateGoal(goal.id)).rejects.toThrow("redis down");
      expect(h.adapter.options.requests).toHaveLength(0);
    }));

  it("crash-resume from RESERVED: same execution id resumes WITHOUT double-charging or double-broadcast", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 1 });
      const slot = goal.nextEvaluationAt; // the execId is derived from THIS slot
      // Run 1: crashes after reserve (lost attempt-marker response).
      h.store.markSpendAttempt = () => Promise.resolve(null);
      expect((await h.runtime.evaluateGoal(goal.id)).kind).toBe("EXECUTION_FAILED");
      expect(h.adapter.options.requests).toHaveLength(0);
      // Run 2 (crash recovery): the slot claim is re-taken (TTL elapsed) and
      // the goal is re-due in the SAME slot — the existing RESERVED
      // reservation is resumed: still ONE charge, ONE broadcast.
      h.store.markSpendAttempt = (...args) => InMemoryAutonomyStore.prototype.markSpendAttempt.apply(h.store, args);
      h.store.claimExecution = () => Promise.resolve(true); // claim lease expired
      const current = (await h.store.getGoal(goal.id))!;
      await h.store.transitionGoal(goal.id, current.wallet, ["WAITING", "ACTIVE"], current.updatedAt, {
        status: "ACTIVE",
        updatedAt: "resume-1",
        nextEvaluationAt: slot,
      });
      const result = await h.runtime.evaluateGoal(goal.id);
      expect(result.kind).toBe("EXECUTION_SUBMITTED");
      expect(h.adapter.options.requests).toHaveLength(1);
      const day = dayOf(h);
      expect(await h.store.getDayLedger(goal.policyId, day)).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
      // Run 3: the same execution id is now COMMITTED — never re-attempted,
      // never double-charged (one-broadcast safety).
      const after = (await h.store.getGoal(goal.id))!;
      await h.store.transitionGoal(goal.id, after.wallet, ["EXECUTING"], after.updatedAt, {
        status: "WAITING",
        updatedAt: "resume-2",
        nextEvaluationAt: slot,
        pendingExecution: null,
      });
      const before = h.adapter.options.requests.length;
      const dup = await h.runtime.evaluateGoal(goal.id);
      expect(dup.kind).toBe("DUPLICATE_PREVENTED");
      expect(h.adapter.options.requests.length).toBe(before);
      expect(await h.store.getDayLedger(goal.policyId, day)).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    }));

  it("switch/infrastructure refusals never permanently fail an active goal", async () =>
    enabled(async () => {
      const h = makeHarness({ authorized: true, requests: [], failWith: { code: "EXECUTION_UNAVAILABLE", message: "posture" } });
      fundWallet(h.state, usdc("100"));
      const { goal } = await createActiveGoal(h, { maxTrades: 3 }, { maxActionsPerDay: 50, maxDailyRaw: usdc("10000") });
      // MCP_DISABLED quote refusal through a stubbed gateway (the switch path).
      const stubGateway: McpGateway = {
        getCapabilities: () => Promise.resolve({ ok: true } as never),
        quote: () => Promise.resolve({ ok: false, failure: { code: "MCP_DISABLED", message: "BASE_MAINNET_DISABLED" } }),
        prepare: () => Promise.resolve({ ok: false, failure: { code: "MCP_DISABLED", message: "off" } }),
        status: () => Promise.resolve({ ok: false, failure: { code: "MCP_DISABLED", message: "off" } }),
        verify: () => Promise.resolve({ ok: false, failure: { code: "MCP_DISABLED", message: "off" } }),
        delegateSwap: () => Promise.resolve({ ok: false, failure: { code: "MCP_DISABLED", message: "off" } }),
        deps: () => ({}) as never,
      };
      const runtime = new AutonomyRuntime({
        store: h.store,
        gateway: stubGateway,
        adapter: h.adapter,
        audit: new BusAuditSink(h.store, h.bus, new InMemoryPerformanceMonitor()),
        logger: silentLogger,
        performanceMonitor: new InMemoryPerformanceMonitor(),
        now: h.now,
      });
      for (let i = 0; i < AUTONOMY_LIMITS.maxConsecutiveFailures + 3; i++) {
        const current = (await h.store.getGoal(goal.id))!;
        await h.store.transitionGoal(goal.id, current.wallet, ["ACTIVE", "WAITING"], current.updatedAt, { status: "ACTIVE", updatedAt: `sw-${i}` });
        const result = await runtime.evaluateGoal(goal.id);
        expect(result.kind).toBe("PARKED");
        if (result.kind === "PARKED") expect(result.failureCode).toBe("MCP_DISABLED");
      }
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).not.toBe("FAILED"); // still observing
      expect(after.stats.consecutiveFailures).toBe(0); // NOT a trade failure
    }));
});
