// lib/autonomy/__tests__/phase5-chain.test.ts
//
// PHASE 5 (final gate addendum) — deterministic proof of the two mandated
// chain links that the on-chain armed run exercises through the production
// runtime but proves most readably off-chain:
//   1. FULL SCHEDULER CHAIN: goal -> scheduler.tick -> policy -> authorization
//      slot -> quote -> broadcast -> verification -> audit -> goal COMPLETED.
//      (The scheduler is the production entrypoint; this proves the whole
//      chain through tick(), not just runtime.evaluateGoal.)
//   2. DUPLICATE EXECUTION REJECTED: after the slot-winning evaluation, an
//      immediate duplicate tick/evaluation CANNOT re-broadcast (lease +
//      idempotency claim + consumed slot), and a consumed slot can never be
//      selected again.
// Deterministic: fake chain state, real gateway/adapter/runtime/scheduler
// seams (same harness as the hardening suites). No live chain.

import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address } from "viem";

import {
  createActiveGoal,
  fundWallet,
  makeHarness,
  usdc,
  WALLET,
  type TestHarness,
} from "./helpers";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import { delegatedSlotId, policyHashFor, selectDelegatedSlot, type DelegatedAuthorizationSlot } from "@/lib/autonomy/delegated-authorization";
import { delegatedActionId } from "@/lib/executor/delegated-executor";
import type { AutonomyPolicy } from "@/lib/autonomy/types";

async function enabled<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
  try {
    return await fn();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("PHASE 5 chain: goal -> SCHEDULER -> policy -> slot -> quote -> broadcast -> verification -> audit -> goal state", () => {
  it("one scheduler tick submits exactly once; the verification tick completes the goal with the full ordered audit chain", async () =>
    enabled(async () => {
      const harness: TestHarness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      const payloads: Array<{ event?: { type?: string } }> = [];
      harness.bus.on("autonomy_audit", (payload: unknown) => payloads.push(payload as { event?: { type?: string } }));
      await createActiveGoal(harness, { maxTrades: 1 });

      // ---- submission pass: through the SCHEDULER (production entrypoint) ----
      const submit = await harness.scheduler.tick({ now: harness.now() });
      expect(submit.evaluated).toBe(1);
      expect(submit.results[0]?.kind).toBe("EXECUTION_SUBMITTED");
      expect(harness.adapter.options.requests).toHaveLength(1); // ONE broadcast

      const goalId = (await harness.store.listGoals(WALLET))[0]!.id;
      const executing = (await harness.store.getGoal(goalId))!;
      expect(executing.status).toBe("EXECUTING");
      expect(executing.pendingExecution?.txHash).toBeTruthy();
      // v1 harness adapter: the runtime records no broadcaster identity (undefined/null)
      expect(executing.pendingExecution?.expectedSender ?? null).toBeFalsy();

      // ---- DUPLICATE EXECUTION REJECTED: immediate second tick must not re-broadcast ----
      const duplicate = await harness.scheduler.tick({ now: harness.now() });
      expect(duplicate.evaluated).toBe(0); // due-gate: verification backoff in the future
      expect(harness.adapter.options.requests).toHaveLength(1); // still ONE broadcast
      // ---- verification pass (after the runtime's verification backoff) ----
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      const verify = await harness.scheduler.tick({ now: harness.now() });
      const completed = (await harness.store.getGoal(goalId))!;
      expect(completed.status, `goal must COMPLETED via the scheduler seam (last result: ${JSON.stringify(completed.lastResult)})`).toBe("COMPLETED");
      expect(completed.pendingExecution).toBeNull();
      expect(harness.adapter.options.requests).toHaveLength(1); // verification, not a re-broadcast

      // ---- duplicate execution rejected at the TERMINAL state too ----
      const forced = await harness.runtime.evaluateGoal(goalId);
      expect(forced.kind === "EXECUTION_SUBMITTED").toBe(false);
      expect(harness.adapter.options.requests).toHaveLength(1); // still exactly ONE broadcast ever

      // ---- full ordered audit chain (mandated set) ----
      const types = payloads.map((p) => p.event?.type ?? "");
      const order = ["QUOTE_CREATED", "CONDITION_CHECKED", "CONDITION_MET", "POLICY_APPROVED", "AUTHORIZATION_CHECKED", "TRADE_PREPARED", "TRANSACTION_SUBMITTED", "EXECUTION_VERIFIED"];
      let last = -1;
      for (const expected of order) {
        const idx = types.indexOf(expected);
        expect(idx, `missing/out-of-order: ${expected} in ${types.join(",")}`).toBeGreaterThan(last);
        last = idx;
      }
      const dumped = JSON.stringify(payloads);
      expect(dumped).not.toMatch(/privateKey|PRIVATE_KEY|mnemonic/i);
      expect(dumped).not.toMatch(/0x[a-fA-F0-9]{130}/);
    }));
});

describe("PHASE 5 chain: consumed authorization slot can never be selected again (duplicate-proof at the seam)", () => {
  it("selectDelegatedSlot refuses a slot marked consumed; the goal's actionId binding still holds for fresh slots", () => {
    const USER = getAddress("0x0000000000000000000000000000000000000002") as Address;
    const SELL = getAddress("0x00000000000000000000000000000000000000a5") as Address;
    const BUY = getAddress("0x00000000000000000000000000000000000000b7") as Address;
    const NOW = new Date("2026-10-01T00:00:00Z");
    const DEADLINE = Math.floor(NOW.getTime() / 1000) + 1800;
    const policy: AutonomyPolicy = {
      id: "pol-p5",
      wallet: USER,
      chainId: 84532,
      actions: ["swap"],
      sellToken: SELL,
      buyToken: BUY,
      maxPerTradeRaw: "10000",
      maxDailyRaw: "50000",
      maxSlippageBps: 500,
      maxActionsPerDay: 2,
      enabled: true,
      createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 6 * 3600_000).toISOString(),
      authorizedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      authorizationRef: "p5",
    };
    const slot = (over: Partial<DelegatedAuthorizationSlot>): DelegatedAuthorizationSlot => ({
      id: delegatedSlotId(policy.id, "goal-p5", 0),
      wallet: USER,
      chainId: 84532,
      policyId: policy.id,
      goalId: "goal-p5",
      slotIndex: 0,
      permit: { token: SELL, amount: "10000", nonce: "100", deadline: DEADLINE },
      witness: {
        owner: USER,
        buyToken: BUY,
        minAmountOut: "1000",
        deadline: DEADLINE,
        actionId: delegatedActionId("goal-p5"),
        policyHash: policyHashFor(policy),
      },
      signature: ("0x" + "22".repeat(65)) as `0x${string}`,
      createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
      ...over,
    });
    const ctx = {
      now: NOW,
      policy,
      sellToken: SELL,
      buyToken: BUY,
      sellAmountRaw: "10000",
      liveMinBuyAmountRaw: "1000",
    };
    // fresh slot selects; the SAME slot consumed does not — ever.
    expect(selectDelegatedSlot([slot({})], ctx).authorized).toBe(true);
    const consumed = selectDelegatedSlot([slot({ consumedAt: new Date(NOW.getTime() + 1).toISOString() })], ctx);
    expect(consumed.authorized).toBe(false);
    expect(consumed.reason).toBe("NO_SLOTS"); // fail-closed, no broadcast possible
  });
});
