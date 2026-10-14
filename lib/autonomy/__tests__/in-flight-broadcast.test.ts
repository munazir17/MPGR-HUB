// lib/autonomy/__tests__/in-flight-broadcast.test.ts
//
// The broadcast ordering contract (runtime.ts, ACT section):
//
//   * the goal is NEVER written to EXECUTING before the adapter returns a hash:
//     it stays ACTIVE/WAITING while the swap is in flight;
//   * EXECUTING + pendingExecution are written together, and only with a tx hash;
//   * an adapter error is persisted by the SAME evaluateGoal call, with the
//     in-flight stage in the message, and the goal is never left EXECUTING;
//   * a hung store on the failure path (state re-read, attempt marker, failure
//     write) is bounded to BROADCAST_STORE_BUDGET_MS, and the stage is logged
//     even when Redis fails;
//   * the stuck-execution reap ignores any goal that was never EXECUTING.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { AUTONOMY_EXECUTION_BUDGET_SECONDS } from "@/lib/autonomy/config";
import { BROADCAST_STORE_BUDGET_MS } from "@/lib/autonomy/runtime";
import { isStuckExecuting, STUCK_EXECUTION_REAP_SECONDS, type DelegatedSwapRequest, type DelegatedSwapResult } from "@/lib/autonomy/types";
import { createActiveGoal, fundWallet, makeHarness, usdc, WALLET, type TestHarness } from "./helpers";

const HASH = `0x${"ab".repeat(32)}`;

function dayOf(h: TestHarness): string {
  return h.now().toISOString().slice(0, 10);
}

describe("in-flight broadcast — ordering, failures and bounded Redis", () => {
  let h: TestHarness;
  let errors: string[];
  let transitionSpy: MockInstance;

  beforeEach(() => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    h = makeHarness({ authorized: true, requests: [], mineReceipt: true });
    fundWallet(h.state, usdc("100"));
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    transitionSpy = vi.spyOn(h.store, "transitionGoal");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Every status the runtime tried to write to the goal, in order. */
  function statusWrites(): Array<string | undefined> {
    return transitionSpy.mock.calls.map((call) => (call[4] as { status?: string }).status);
  }

  describe("ordering", () => {
    it("a hung executeSwap leaves the goal ACTIVE/WAITING (never EXECUTING), names the stage, and does not consume the slot", async () => {
      const { goal, policy } = await createActiveGoal(h, { maxTrades: 3 });
      const seenDuringFlight: string[] = [];
      let onStart!: () => void;
      const started = new Promise<void>((resolve) => {
        onStart = resolve;
      });
      h.adapter.executeSwap = async (req: DelegatedSwapRequest): Promise<DelegatedSwapResult> => {
        seenDuringFlight.push((await h.store.getGoal(goal.id))!.status);
        req.onStage?.("estimate");
        onStart();
        return new Promise<never>(() => {}); // never returns
      };

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = h.runtime.evaluateGoal(goal.id);
      await started;
      expect(seenDuringFlight).toEqual(["ACTIVE"]);

      await vi.advanceTimersByTimeAsync(AUTONOMY_EXECUTION_BUDGET_SECONDS * 1000);
      const result = await pending;

      expect(result).toMatchObject({ kind: "EXECUTION_FAILED", failureCode: "RPC_ERROR" });
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING"); // RPC_ERROR is retryable, not FAILED
      expect(after.pendingExecution).toBeNull();
      expect(after.lastResult?.code).toBe("RPC_ERROR");
      expect(after.lastResult?.message).toMatch(/RPC timeout/);
      expect(after.lastResult?.message).toMatch(/in-flight stage: estimate/);
      expect(after.lastResult?.message).not.toMatch(/no transaction recorded/i);

      // EXECUTING was never written: not during the call, not at the timeout.
      expect(statusWrites()).not.toContain("EXECUTING");
      // No hash, so no slot consumption. The spend stays counted (it may have reached the node).
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
      expect(errors.some((line) => line.includes("estimate"))).toBe(true);
    });

    it("a returned hash sets EXECUTING with that hash, and only then", async () => {
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      let statusAtCall = "";
      h.adapter.executeSwap = async (req: DelegatedSwapRequest): Promise<DelegatedSwapResult> => {
        statusAtCall = (await h.store.getGoal(goal.id))!.status;
        req.onStage?.("send");
        return { ok: true, txHash: HASH };
      };

      const result = await h.runtime.evaluateGoal(goal.id);

      expect(result).toMatchObject({ kind: "EXECUTION_SUBMITTED", txHash: HASH });
      expect(statusAtCall).toBe("ACTIVE");
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("EXECUTING");
      expect(after.pendingExecution?.txHash).toBe(HASH);
      expect(statusWrites().filter((s) => s === "EXECUTING")).toHaveLength(1);
      expect((await h.store.listActionRecords(goal.id)).some((a) => a.txHash === HASH)).toBe(true);
    });

    it("an estimate revert stores EXECUTION_UNAVAILABLE in the SAME call, with the stage, and never leaves the goal EXECUTING", async () => {
      const { goal, policy } = await createActiveGoal(h, { maxTrades: 3 });
      h.adapter.executeSwap = async (req: DelegatedSwapRequest): Promise<DelegatedSwapResult> => {
        req.onStage?.("estimate");
        return { ok: false, code: "EXECUTION_UNAVAILABLE", message: "Execution reverted with reason: InvalidNonce." };
      };

      // ONE call: the awaited result already reflects the persisted failure.
      const result = await h.runtime.evaluateGoal(goal.id);

      expect(result).toMatchObject({ kind: "EXECUTION_FAILED", failureCode: "EXECUTION_UNAVAILABLE" });
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.pendingExecution).toBeNull();
      expect(after.lastResult?.code).toBe("EXECUTION_UNAVAILABLE");
      expect(after.lastResult?.message).toMatch(/Execution reverted with reason: InvalidNonce/);
      expect(after.lastResult?.message).toMatch(/\[stage: estimate\]/);
      expect(after.stats.consecutiveFailures).toBe(1);
      expect(statusWrites()).not.toContain("EXECUTING");
      // Nothing was broadcast: a pre-broadcast refusal releases the reservation.
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
    });

    it("an adapter that THROWS is persisted in the same call with its stage; the spend stays counted; the raw error is not stored", async () => {
      const { goal, policy } = await createActiveGoal(h, { maxTrades: 3 });
      h.adapter.executeSwap = async (req: DelegatedSwapRequest): Promise<DelegatedSwapResult> => {
        req.onStage?.("send");
        throw new Error("socket reset");
      };

      const result = await h.runtime.evaluateGoal(goal.id);

      expect(result).toMatchObject({ kind: "EXECUTION_FAILED", failureCode: "EXECUTION_UNAVAILABLE" });
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.lastResult?.message).toMatch(/broadcast outcome is UNKNOWN/);
      expect(after.lastResult?.message).toMatch(/\[stage: send\]/);
      expect(after.lastResult?.message).not.toMatch(/socket reset/);
      expect(statusWrites()).not.toContain("EXECUTING");
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: usdc("20"), actions: 1 });
    });

    it("a user pause during the swap does not lose the hash: it stays in the action record, and PAUSED is not forced to EXECUTING", async () => {
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      h.adapter.executeSwap = async (): Promise<DelegatedSwapResult> => {
        await h.store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { status: "PAUSED", updatedAt: h.now().toISOString() });
        return { ok: true, txHash: HASH };
      };

      const result = await h.runtime.evaluateGoal(goal.id);

      expect(result).toMatchObject({ kind: "EXECUTION_SUBMITTED", txHash: HASH });
      expect((await h.store.getGoal(goal.id))!.status).toBe("PAUSED");
      expect((await h.store.listActionRecords(goal.id)).some((a) => a.txHash === HASH && a.status === "SUBMITTED")).toBe(true);
      expect(errors.some((line) => line.includes(HASH) && line.includes("reconcile"))).toBe(true);
    });

    it("a field edit during the swap does not lose the hash: the EXECUTING write is retried against the fresh updatedAt", async () => {
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      const editedAt = new Date(Date.parse(goal.updatedAt) + 1_000).toISOString();
      h.adapter.executeSwap = async (): Promise<DelegatedSwapResult> => {
        // Same status (ACTIVE), different updatedAt: the CAS on the old value misses.
        await h.store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { updatedAt: editedAt });
        return { ok: true, txHash: HASH };
      };

      const result = await h.runtime.evaluateGoal(goal.id);

      expect(result).toMatchObject({ kind: "EXECUTION_SUBMITTED", txHash: HASH });
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("EXECUTING");
      expect(after.pendingExecution?.txHash).toBe(HASH);
    });

    it("a hash that returns AFTER the budget ended moves the goal to EXECUTING with that hash; the earlier timeout stays on record until then", async () => {
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      let onStart!: () => void;
      const started = new Promise<void>((resolve) => {
        onStart = resolve;
      });
      let releaseLate!: (value: DelegatedSwapResult) => void;
      const late = new Promise<DelegatedSwapResult>((resolve) => {
        releaseLate = resolve;
      });
      h.adapter.executeSwap = async (req: DelegatedSwapRequest): Promise<DelegatedSwapResult> => {
        req.onStage?.("send");
        onStart();
        return late;
      };

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = h.runtime.evaluateGoal(goal.id);
      await started;
      await vi.advanceTimersByTimeAsync(AUTONOMY_EXECUTION_BUDGET_SECONDS * 1000);
      expect(await pending).toMatchObject({ kind: "EXECUTION_FAILED", failureCode: "RPC_ERROR" });
      expect((await h.store.getGoal(goal.id))!.status).toBe("WAITING");

      // The node answers after the tick gave up.
      releaseLate({ ok: true, txHash: HASH });
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));

      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("EXECUTING");
      expect(after.pendingExecution?.txHash).toBe(HASH);
      expect((await h.store.listActionRecords(goal.id)).some((a) => a.txHash === HASH && a.status === "SUBMITTED")).toBe(true);
      expect(statusWrites().filter((s) => s === "EXECUTING")).toHaveLength(1);
    });

    it("a goal closed during prepare is never broadcast: the reservation is released UNATTEMPTED and the claim dropped", async () => {
      const { goal, policy } = await createActiveGoal(h, { maxTrades: 3 });
      const realReserve = h.store.reserveDailySpend.bind(h.store);
      h.store.reserveDailySpend = async (input) => {
        const reserved = await realReserve(input);
        // The user pauses after the reservation and before the broadcast starts.
        await h.store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { status: "PAUSED", updatedAt: h.now().toISOString() });
        return reserved;
      };

      const result = await h.runtime.evaluateGoal(goal.id);

      expect(result).toMatchObject({ kind: "SKIPPED", reason: "STATE_CHANGED" });
      expect(h.adapter.options.requests).toHaveLength(0);
      expect((await h.store.getGoal(goal.id))!.status).toBe("PAUSED");
      expect(await h.store.getDayLedger(policy.id, dayOf(h))).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
    });
  });

  describe("bounded Redis on the failure path", () => {
    it("the bound is 3 seconds", () => {
      expect(BROADCAST_STORE_BUDGET_MS).toBe(3_000);
    });

    it("a hung attempt marker fails closed after 3 s: the adapter is never invoked and the stage is logged", async () => {
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      let onMarker!: () => void;
      const markerCalled = new Promise<void>((resolve) => {
        onMarker = resolve;
      });
      h.store.markSpendAttempt = () => {
        onMarker();
        return new Promise<never>(() => {});
      };

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = h.runtime.evaluateGoal(goal.id);
      await markerCalled;
      await vi.advanceTimersByTimeAsync(BROADCAST_STORE_BUDGET_MS);
      const result = await pending;

      expect(result).toMatchObject({ kind: "EXECUTION_FAILED", failureCode: "RPC_ERROR" });
      expect(h.adapter.options.requests).toHaveLength(0);
      const after = (await h.store.getGoal(goal.id))!;
      expect(after.status).toBe("WAITING");
      expect(after.lastResult?.message).toMatch(/attempt marker could not be persisted/);
      expect(errors.some((line) => line.includes("attempt-marker"))).toBe(true);
    });

    it("when the failure write hangs too, the goal still resolves within the bounds and the stage is still logged", async () => {
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      let onMarker!: () => void;
      const markerCalled = new Promise<void>((resolve) => {
        onMarker = resolve;
      });
      let onWrite!: () => void;
      const writeCalled = new Promise<void>((resolve) => {
        onWrite = resolve;
      });
      h.store.markSpendAttempt = () => {
        onMarker();
        return new Promise<never>(() => {});
      };
      h.store.transitionGoal = () => {
        onWrite();
        return new Promise<never>(() => {});
      };

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = h.runtime.evaluateGoal(goal.id);
      await markerCalled;
      await vi.advanceTimersByTimeAsync(BROADCAST_STORE_BUDGET_MS); // marker bound
      await writeCalled;
      await vi.advanceTimersByTimeAsync(BROADCAST_STORE_BUDGET_MS); // failure-write bound
      const result = await pending;

      expect(result).toMatchObject({ kind: "EXECUTION_FAILED", failureCode: "RPC_ERROR" });
      expect(h.adapter.options.requests).toHaveLength(0);
      expect(errors.some((line) => line.includes("attempt-marker"))).toBe(true);
      expect(errors.some((line) => line.includes("did not answer within 3000 ms"))).toBe(true);
    });
  });

  describe("the stuck-execution reap", () => {
    it("isStuckExecuting is false for ACTIVE, WAITING and PAUSED goals however stale, and true only for a stale EXECUTING goal", () => {
      const long = new Date(Date.now() - 10 * STUCK_EXECUTION_REAP_SECONDS * 1000).toISOString();
      for (const status of ["ACTIVE", "WAITING", "PAUSED"] as const) {
        expect(isStuckExecuting({ status, pendingExecution: null, lastEvaluationAt: long, updatedAt: long }, new Date())).toBe(false);
      }
      expect(isStuckExecuting({ status: "EXECUTING", pendingExecution: null, lastEvaluationAt: long, updatedAt: long }, new Date())).toBe(true);
    });

    it("the scheduler never reaps an ACTIVE goal with stale timestamps", async () => {
      const { goal } = await createActiveGoal(h, { maxTrades: 3 });
      h.advanceClock(STUCK_EXECUTION_REAP_SECONDS * 1000 * 5);
      const summary = await h.scheduler.tick({ now: h.now() });
      expect(summary.results.some((r) => r.kind === "STUCK_EXECUTION_REAPED")).toBe(false);
      expect((await h.store.getGoal(goal.id))!.lastResult?.message ?? "").not.toMatch(/no automatic retry/i);
    });
  });
});
