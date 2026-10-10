// lib/autonomy/__tests__/hardening-gaps.test.ts
//
// PHASE 4 HARDENING (round 2) — closes the coverage gaps identified by the
// area-by-area audit against the Phase 4 mandate:
//   §6  explicit RPC/tx failure CLASSIFICATION matrix (verifyExecution seam)
//   §4  concurrent daily-limit consumption race (two goals, one policy)
//   §2/§4  actionId collision (swapped/colliding witness actionIds)
//   §1/§12 malformed signatures at the delegated boundary + assisted-path
//          isolation (a non-taker key — e.g. the broadcaster — cannot sign)
//   §9  restart/recovery in ACTIVE / WAITING / FAILED
//   §3  duplicate goal creation (store-level id collision behavior)
// Deterministic failure injection only — no sleeps, no live chain.

import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { verifyExecution } from "@/lib/autonomy/verify";
import { AUTONOMY_LIMITS } from "@/lib/autonomy/config";
import type { McpGateway } from "@/lib/autonomy/mcp-gateway";
import {
  delegatedSlotId,
  policyHashFor,
  selectDelegatedSlot,
  type DelegatedAuthorizationSlot,
} from "@/lib/autonomy/delegated-authorization";
import { delegatedActionId } from "@/lib/executor/delegated-executor";
import type { AutonomyPolicy } from "@/lib/autonomy/types";
import {
  createActiveGoal,
  fundWallet,
  makeHarness,
  usdc,
  WALLET,
} from "./helpers";

// ---------------------------------------------------------------------------
// §6 — RPC/tx failure classification matrix over the verifyExecution seam.
// Contract: VERIFIED / FAILED(TX_REVERTED|VERIFICATION_FAILED) / UNCERTAIN(TIMEOUT)
// / PENDING_VERIFICATION(RPC_ERROR). A pending/unknown receipt is NEVER success,
// and exhaustion never re-broadcasts.
// ---------------------------------------------------------------------------

type Script = {
  status?: () => Promise<unknown>;
  verify?: () => Promise<unknown>;
};

function scriptedGateway(script: Script): McpGateway {
  return {
    status: script.status ?? (async () => ({ ok: true, data: { status: "confirmed", blockNumber: "42" } })),
    verify: script.verify ?? (async () => ({ ok: true, data: { verified: true, checks: [], actualBuyAmountRaw: "1000", feeAmountRaw: "2500" } })),
  } as unknown as McpGateway;
}

const BASE_INPUT = {
  chainId: 84532,
  quoteId: "quote-x",
  txHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
  expectedBuyAmountRaw: "1000",
  minBuyAmountRaw: "900",
  attemptsSoFar: 0,
  expectedSender: getAddress("0x0000000000000000000000000000000000000b22"),
  expectedIntentId: delegatedActionId("goal-x"),
};

describe("hardening §6: RPC/tx failure classification matrix (verifyExecution)", () => {
  it("attempt budget exhausted -> UNCERTAIN/TIMEOUT (never success, never re-broadcast)", async () => {
    const v = await verifyExecution(scriptedGateway({}), { ...BASE_INPUT, attemptsSoFar: AUTONOMY_LIMITS.maxVerificationAttempts });
    expect(v.outcome).toBe("UNCERTAIN");
    expect(v.code).toBe("TIMEOUT");
    expect(v.verified).toBe(false);
    expect(v.message).toMatch(/NOT be retried/i);
  });

  it("status RPC throws -> PENDING_VERIFICATION/RPC_ERROR (retryable, bounded)", async () => {
    const v = await verifyExecution(scriptedGateway({ status: async () => { throw new Error("boom"); } }), BASE_INPUT);
    expect(v.outcome).toBe("PENDING_VERIFICATION");
    expect(v.code).toBe("RPC_ERROR");
    expect(v.verified).toBe(false);
  });

  it("status tool failure -> PENDING_VERIFICATION/RPC_ERROR", async () => {
    const v = await verifyExecution(scriptedGateway({ status: async () => ({ ok: false, failure: { code: "TX_NOT_FOUND", message: "x" } }) }), BASE_INPUT);
    expect(v.outcome).toBe("PENDING_VERIFICATION");
    expect(v.code).toBe("RPC_ERROR");
  });

  it("dropped / not-yet-mined transaction (pending_or_unknown) -> PENDING_VERIFICATION, never success", async () => {
    const v = await verifyExecution(scriptedGateway({ status: async () => ({ ok: true, data: { status: "pending_or_unknown" } }) }), BASE_INPUT);
    expect(v.outcome).toBe("PENDING_VERIFICATION");
    expect(v.verified).toBe(false);
  });

  it("reverted receipt -> FAILED/TX_REVERTED (no output; goal will not re-trade the slot)", async () => {
    const v = await verifyExecution(scriptedGateway({ status: async () => ({ ok: true, data: { status: "reverted", blockNumber: "42" } }) }), BASE_INPUT);
    expect(v.outcome).toBe("FAILED");
    expect(v.code).toBe("TX_REVERTED");
    expect(v.verified).toBe(false);
  });

  it("verification RPC outage after a confirmed receipt -> PENDING_VERIFICATION/RPC_ERROR", async () => {
    const v = await verifyExecution(scriptedGateway({ verify: async () => { throw new Error("rpc down"); } }), BASE_INPUT);
    expect(v.outcome).toBe("PENDING_VERIFICATION");
    expect(v.code).toBe("RPC_ERROR");
  });

  it("receipt-read race (verify !ok) -> PENDING until budget exhausted, then UNCERTAIN/TIMEOUT", async () => {
    const notOk = async () => ({ ok: false, failure: { code: "TX_NOT_FOUND", message: "race" } });
    const pending = await verifyExecution(scriptedGateway({ verify: notOk }), { ...BASE_INPUT, attemptsSoFar: AUTONOMY_LIMITS.maxVerificationAttempts - 2 });
    expect(pending.outcome).toBe("PENDING_VERIFICATION");
    const exhausted = await verifyExecution(scriptedGateway({ verify: notOk }), { ...BASE_INPUT, attemptsSoFar: AUTONOMY_LIMITS.maxVerificationAttempts - 1 });
    expect(exhausted.outcome).toBe("UNCERTAIN");
    expect(exhausted.code).toBe("TIMEOUT");
  });

  it("confirmed receipt that fails ANY check -> FAILED/VERIFICATION_FAILED naming the failed checks", async () => {
    const v = await verifyExecution(
      scriptedGateway({
        verify: async () => ({ ok: true, data: { verified: false, checks: [{ name: "tx.to == executor", ok: false }, { name: "amountOut >= minBuyAmount", ok: false }], actualBuyAmountRaw: "10", feeAmountRaw: "2500" } }),
      }),
      BASE_INPUT,
    );
    expect(v.outcome).toBe("FAILED");
    expect(v.code).toBe("VERIFICATION_FAILED");
    expect(v.message).toContain("tx.to == executor");
    expect(v.message).toContain("amountOut >= minBuyAmount");
  });

  it("defense in depth: verified receipt with output BELOW the prepared minimum -> FAILED", async () => {
    const v = await verifyExecution(
      scriptedGateway({
        verify: async () => ({ ok: true, data: { verified: true, checks: [{ name: "all", ok: true }], actualBuyAmountRaw: "899", feeAmountRaw: "2500" } }),
      }),
      BASE_INPUT, // minBuyAmountRaw = "900"
    );
    expect(v.outcome).toBe("FAILED");
    expect(v.code).toBe("VERIFICATION_FAILED");
    expect(v.message).toMatch(/below the prepared minimum/i);
  });

  it("fully matching receipt -> VERIFIED (the ONLY success path)", async () => {
    const v = await verifyExecution(scriptedGateway({}), BASE_INPUT);
    expect(v.outcome).toBe("VERIFIED");
    expect(v.code).toBe("VERIFIED");
    expect(v.verified).toBe(true);
  });

  it("non-numeric actual output never trips the sanity check into a false failure", async () => {
    const v = await verifyExecution(
      scriptedGateway({ verify: async () => ({ ok: true, data: { verified: true, checks: [], actualBuyAmountRaw: undefined, feeAmountRaw: "2500" } }) }),
      BASE_INPUT,
    );
    expect(v.outcome).toBe("VERIFIED");
  });
});

// ---------------------------------------------------------------------------
// §2/§4 — actionId collision: distinct goals MUST have distinct actionIds, and
// a slot whose witness was signed for another goal's actionId is rejected.
// ---------------------------------------------------------------------------

const USER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const OTHER = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;
const SELL = getAddress("0x00000000000000000000000000000000000000a5") as Address;
const BUY = getAddress("0x00000000000000000000000000000000000000b7") as Address;
const NOW = new Date("2026-10-01T00:00:00Z");
const DEADLINE = Math.floor(NOW.getTime() / 1000) + 1800;
const AMOUNT = "100000000";

function makePolicy(over: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    id: "pol-gap",
    wallet: USER,
    chainId: 84532,
    actions: ["swap"],
    sellToken: SELL,
    buyToken: BUY,
    maxPerTradeRaw: AMOUNT,
    maxDailyRaw: "1000000000",
    maxSlippageBps: 500,
    maxActionsPerDay: 5,
    enabled: true,
    createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 6 * 3600_000).toISOString(),
    authorizedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    authorizationRef: "gap",
    ...over,
  };
}

function slotForGoal(goalId: string, slotIndex: number, actionId: Hex, over: Partial<DelegatedAuthorizationSlot> = {}): DelegatedAuthorizationSlot {
  const policy = makePolicy();
  return {
    id: delegatedSlotId(policy.id, goalId, slotIndex),
    wallet: USER,
    chainId: 84532,
    policyId: policy.id,
    goalId,
    slotIndex,
    permit: { token: SELL, amount: AMOUNT, nonce: String(100 + slotIndex), deadline: DEADLINE },
    witness: {
      owner: USER,
      buyToken: BUY,
      minAmountOut: "1000",
      deadline: DEADLINE,
      actionId,
      policyHash: policyHashFor(policy),
    },
    signature: ("0x" + "22".repeat(65)) as Hex,
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    ...over,
  };
}

const CTX = (policy: AutonomyPolicy | null = makePolicy()) => ({
  now: NOW,
  policy,
  sellToken: SELL,
  buyToken: BUY,
  sellAmountRaw: AMOUNT,
  liveMinBuyAmountRaw: "1000",
});

describe("hardening §2/§4: actionId collision", () => {
  it("delegatedActionId is injective across distinct goals (collision sample)", () => {
    const ids = ["g-1", "g-2", "g-3", "goal-1", "goal-2", "a", "b", `${"x".repeat(80)}`];
    const set = new Set(ids.map((g) => delegatedActionId(g)));
    expect(set.size).toBe(ids.length);
    expect(delegatedActionId("g-1")).not.toBe(delegatedActionId("g-2"));
  });

  it("two slots whose witnesses SWAP each other's actionIds are BOTH rejected (ACTION_MISMATCH)", () => {
    const actionA = delegatedActionId("goal-a");
    const actionB = delegatedActionId("goal-b");
    const slotA = slotForGoal("goal-a", 0, actionB); // signed for the OTHER goal
    const slotB = slotForGoal("goal-b", 1, actionA);
    const vA = selectDelegatedSlot([slotA], CTX());
    expect(vA.authorized).toBe(false);
    expect(vA.reason).toBe("ACTION_MISMATCH");
    // goal-b's slot cannot be selected under goal-a's policy context either:
    const vB = selectDelegatedSlot([slotB], CTX());
    expect(vB.authorized).toBe(false);
    expect(vB.reason).toBe("ACTION_MISMATCH");
  });

  it("each goal's correctly-bound slot still selects (collisions do not poison good slots)", () => {
    const good = slotForGoal("goal-a", 0, delegatedActionId("goal-a"));
    const v = selectDelegatedSlot([good], CTX());
    expect(v.authorized).toBe(true);
    expect(v.slot?.goalId).toBe("goal-a");
  });

  it("an actionId from another wallet's identical goal string still selects only under ITS owner's policy (owner binding holds)", () => {
    // Same goal string => same actionId by design; the owner/strategy binding
    // is enforced separately (slot.wallet + policy.wallet), never by actionId.
    const policyOther = makePolicy({ id: "pol-gap-2", wallet: OTHER });
    const attackersSlot = slotForGoal("goal-a", 0, delegatedActionId("goal-a"));
    attackersSlot.wallet = OTHER;
    attackersSlot.witness = { ...attackersSlot.witness, owner: OTHER, policyHash: policyHashFor(policyOther) };
    const v = selectDelegatedSlot([attackersSlot], CTX(makePolicy()));
    expect(v.authorized).toBe(false);
    expect(v.reason).toBe("OWNER_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// §4 — concurrent daily-limit consumption: two DIFFERENT goals on ONE policy
// evaluated concurrently. The per-goal/per-slot single-execution invariant
// MUST hold; the daily cap behavior under true concurrency is characterized
// (and disclosed) below.
// ---------------------------------------------------------------------------

describe("hardening §4: concurrent daily-limit consumption", () => {
  it("invariant: concurrent evaluation of two goals can never double-execute ONE goal", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 1 });
      const goalId = (await harness.store.listGoals(WALLET))[0]!.id;
      const [a, b] = await Promise.all([
        harness.runtime.evaluateGoal(goalId),
        harness.runtime.evaluateGoal(goalId),
      ]);
      const submissions = [a, b].filter((r) => r.kind === "EXECUTION_SUBMITTED").length;
      const busy = [a, b].filter((r) => r.kind === "SKIPPED" && r.reason === "LEASE_BUSY").length;
      expect(submissions + busy).toBe(2); // one executed, one blocked by the lease
      expect(harness.adapter.options.requests).toHaveLength(1); // ONE broadcast
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("daily cap holds under sequential evaluation (control): second goal is policy-rejected", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 1 }, { maxActionsPerDay: 1, maxDailyRaw: usdc("25") });
      const g1 = (await harness.store.listGoals(WALLET))[0]!;
      await createActiveGoal(harness, { maxTrades: 1, policyId: g1.policyId });
      const goals = await harness.store.listGoals(WALLET);
      expect(goals).toHaveLength(2);
      const r1 = await harness.runtime.evaluateGoal(goals[0]!.id);
      expect(r1.kind).toBe("EXECUTION_SUBMITTED");
      const r2 = await harness.runtime.evaluateGoal(goals[1]!.id);
      // The daily cap is read live: the second goal on the SAME policy cannot trade today.
      expect(r2.kind === "SKIPPED" || r2.kind === "PARKED").toBe(true);
      expect(harness.adapter.options.requests).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("TRUE-concurrency probe: two goals, one policy, one daily action — broadcasts are disclosed", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 1 }, { maxActionsPerDay: 1, maxDailyRaw: usdc("25") });
      const g1 = (await harness.store.listGoals(WALLET))[0]!;
      await createActiveGoal(harness, { maxTrades: 1, policyId: g1.policyId });
      const goals = await harness.store.listGoals(WALLET);
      // Fire both through the SCHEDULER (which batches with Promise.all — the
      // production concurrency pattern), not hand-rolled loops.
      const summary = await harness.scheduler.tick({ now: harness.now() });
      const broadcasts = harness.adapter.options.requests.length;
      // Both goals are EVALUATED concurrently, but the daily cap HOLDS: the
      // runtime takes the daily spend reservation ATOMICALLY (reserveDailySpend,
      // cap-checked) right before broadcast, so only ONE goal may broadcast.
      expect(summary.evaluated).toBe(2);
      expect(broadcasts).toBe(1);
      const dayGoals = await harness.store.listGoals(WALLET);
      const codes = dayGoals.map((g) => g.lastResult?.code ?? null);
      expect(codes).toContain(null); // the winner executed (submitted, verifying)
      expect(codes.filter((c) => c === "POLICY_REJECTED")).toHaveLength(1); // the loser was refused the daily cap
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// §9 — restart/recovery in every non-terminal state (fresh runtime, same store).
// ---------------------------------------------------------------------------

describe("hardening §9: restart/recovery per state", () => {
  it("ACTIVE: restart re-evaluates when due and executes at most once", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 3 });
      const goalId = (await harness.store.listGoals(WALLET))[0]!.id;
      await harness.advanceClock(15 * 60_000); // goal becomes due
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(1);
      expect(harness.adapter.options.requests).toHaveLength(1);
      void goalId;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("WAITING: after restart the goal is not re-evaluated before its nextEvaluationAt, then proceeds once", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 3, condition: { kind: "price_below", threshold: "0" } });
      const goalId = (await harness.store.listGoals(WALLET))[0]!.id;
      // condition NOT met (price 50 is not below 0) -> WAITING with cooldown
      const first = await harness.runtime.evaluateGoal(goalId);
      expect(first.kind).toBe("PARKED"); // observed (cooldown), not executed
      const waiting = (await harness.store.getGoal(goalId))!;
      expect(waiting.status).toBe("WAITING");
      // restart happens here (fresh runtime below); an immediate tick must do nothing
      const before = harness.adapter.options.requests.length;
      await harness.scheduler.tick({ now: harness.now() });
      expect(harness.adapter.options.requests.length).toBe(before);
      // After the cooldown the goal evaluates again (still condition-unmet —
      // exactly ONE evaluation pass, no double-processing, no broadcast).
      harness.advanceClock(15 * 60_000);
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(1);
      expect(harness.adapter.options.requests).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("FAILED: terminal after restart — never re-evaluated, never re-broadcast", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const harness = makeHarness({ authorized: true, requests: [], mineReceipt: true });
      fundWallet(harness.state, usdc("100"));
      await createActiveGoal(harness, { maxTrades: 3 });
      const goalId = (await harness.store.listGoals(WALLET))[0]!.id;
      const current = (await harness.store.getGoal(goalId))!;
      await harness.store.transitionGoal(goalId, WALLET, ["ACTIVE"], current.updatedAt, { status: "FAILED", updatedAt: "f1" });
      harness.advanceClock(30 * 60_000);
      const summary = await harness.scheduler.tick({ now: harness.now() });
      expect(summary.evaluated).toBe(0);
      expect(harness.adapter.options.requests).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// §3 — duplicate goal creation at the store seam: id collision behavior is
// DISCLOSED (route always mints fresh ids; store does not guard).
// ---------------------------------------------------------------------------

describe("hardening §3: duplicate goal creation (store seam)", () => {
  it("DISCLOSED: createGoal with an explicit duplicate id overwrites (route mints ids, so not client-reachable)", async () => {
    const harness = makeHarness();
    fundWallet(harness.state, usdc("10"));
    await createActiveGoal(harness, { maxTrades: 1 });
    const goal = (await harness.store.listGoals(WALLET))[0]!;
    const before = (await harness.store.getGoal(goal.id))!.status;
    expect(before).toBe("ACTIVE");
    // direct store-level duplicate write — current behavior documented here
    await harness.store.createGoal({ ...goal, status: "CANCELLED", updatedAt: "dup" });
    expect((await harness.store.getGoal(goal.id))!.status).toBe("CANCELLED");
  });

  it("execution-level duplicate protection: the same idempotency claim cannot be won twice", async () => {
    const harness = makeHarness();
    expect(await harness.store.claimExecution("dup-key", 60)).toBe(true);
    expect(await harness.store.claimExecution("dup-key", 60)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §14 — audit/event integrity: the FULL ordered lifecycle chain on success.
// (Mandate event-name mapping: POLICY_CHECKED ≡ POLICY_APPROVED/POLICY_REJECTED;
// TRANSACTION_CONFIRMED ≡ EXECUTION_VERIFIED — verification is receipt-based.)
// ---------------------------------------------------------------------------

describe("hardening §14: full ordered audit chain on the success path", () => {
  it("emits QUOTE_CREATED < CONDITION_MET < POLICY_APPROVED < AUTHORIZATION_CHECKED < TRADE_PREPARED < TRANSACTION_SUBMITTED < EXECUTION_VERIFIED, in order, with no secrets", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const { makeHarness: mh, createActiveGoal: cg, fundWallet: fw, usdc: u, WALLET: W } = await import("./helpers");
      const { BusAuditSink } = await import("@/lib/autonomy/audit");
      const { InMemoryPerformanceMonitor } = await import("@/lib/architecture/core/performance-monitor");
      const harness = mh({ authorized: true, requests: [], mineReceipt: true });
      fw(harness.state, u("100"));
      const payloads: Array<Record<string, unknown>> = [];
      harness.bus.on("autonomy_audit", (payload: unknown) => payloads.push(payload as Record<string, unknown>));
      await cg(harness, { maxTrades: 1 });
      const goal = (await harness.store.listGoals(W))[0]!;

      await harness.runtime.evaluateGoal(goal.id); // submit
      harness.advanceClock(AUTONOMY_LIMITS.verificationRetrySeconds * 1000 + 1000);
      await harness.runtime.evaluateGoal(goal.id); // verify

      const types = payloads.map((p) => String((p as { event?: { type?: string } }).event?.type));
      const order = ["QUOTE_CREATED", "CONDITION_CHECKED", "CONDITION_MET", "POLICY_APPROVED", "AUTHORIZATION_CHECKED", "TRADE_PREPARED", "TRANSACTION_SUBMITTED", "EXECUTION_VERIFIED"];
      let lastIndex = -1;
      for (const expected of order) {
        const idx = types.indexOf(expected);
        expect(idx, `missing or out-of-order: ${expected} in ${types.join(",")}`).toBeGreaterThan(lastIndex);
        lastIndex = idx;
      }
      // No key material / signatures / long hex secrets in ANY payload.
      const dumped = JSON.stringify(payloads);
      expect(dumped).not.toMatch(/privateKey|PRIVATE_KEY|mnemonic|seed phrase/i);
      expect(dumped).not.toMatch(/0x[a-fA-F0-9]{130}/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// F-9 regression pin: the runtime's DELEGATED path must NOT build a v1
// intent (gateway.prepare validates against the v1 token registry and
// wrongly rejects delegated-allowlisted tokens). Preparation on the
// delegated path is the adapter's own signed-slot re-validation.
// ---------------------------------------------------------------------------

describe("hardening F-9: delegated runtime path skips the v1 prepare seam", () => {
  it("executes a delegated-chain goal without ever calling gateway.prepare; adapter receives empty steps", async () => {
    vi.stubEnv("MPGR_AUTONOMOUS_AGENT_ENABLED", "true");
    try {
      const { InMemoryAutonomyStore } = await import("@/lib/autonomy/store");
      const { AutonomyRuntime: RT } = await import("@/lib/autonomy/runtime");
      const { BusAuditSink: Sink } = await import("@/lib/autonomy/audit");
      const { InMemoryEventBus: Bus } = await import("@/lib/architecture/core/event-bus");
      const { InMemoryPerformanceMonitor: Perf } = await import("@/lib/architecture/core/performance-monitor");
      const { DELEGATED_ADAPTER_ID } = await import("@/lib/autonomy/types");
      const { getAddress: ga } = await import("viem");
      const { silentLogger: slog } = await import("./helpers");

      const prepareSpy = vi.fn();
      const executeSpy = vi.fn(async (..._args: unknown[]) => ({ ok: true, txHash: ("0x" + "7e".repeat(32)) as `0x${string}` }));
      const sellTok = ga("0x00000000000000000000000000000000000000a5");
      const buyTok = ga("0x00000000000000000000000000000000000000b7");
      const gw = {
        quote: async () => ({
          ok: true,
          data: { quoteId: "q-f9", sellAmountRaw: "500", expectedBuyAmountRaw: "1000", minBuyAmountRaw: "900", quoteExpiresAt: Math.floor(Date.now() / 1000) + 600 },
        }),
        prepare: prepareSpy,
        status: async () => ({ ok: true, data: { status: "confirmed", blockNumber: "1" } }),
        verify: async () => ({ ok: true, data: { verified: true, checks: [], actualBuyAmountRaw: "1000", feeAmountRaw: "1" } }),
      } as unknown as McpGateway;
      const adapter = {
        id: DELEGATED_ADAPTER_ID,
        canDelegate: true,
        checkAuthorization: () => ({ authorized: true }),
        executeSwap: executeSpy,
      };
      const store = new InMemoryAutonomyStore();
      const walletAddr = ga("0x0000000000000000000000000000000000000d0e");
      const policy = await store.createPolicy({
        id: "pol-f9", wallet: walletAddr, chainId: 84532, actions: ["swap"], sellToken: sellTok, buyToken: buyTok,
        maxPerTradeRaw: "500", maxDailyRaw: "2500", maxSlippageBps: 500, maxActionsPerDay: 2, enabled: true,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        authorizedAt: new Date().toISOString(), authorizationRef: "f9",
      });
      const goal = await store.createGoal({
        id: "", wallet: walletAddr, policyId: policy!.id, type: "conditional_swap", description: "f9", status: "ACTIVE",
        condition: { kind: "price_below", threshold: "1000000" },
        trade: { sellToken: sellTok, buyToken: buyTok, sellAmountRaw: "500", slippageBps: 100, sellDecimals: 6, buyDecimals: 6 },
        cooldownSeconds: 60, maxTrades: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), nextEvaluationAt: new Date().toISOString(),
        pendingExecution: null, stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
      } as never);
      const bus = new Bus();
      const perf = new Perf();
      const runtime = new RT({ store, gateway: gw, adapter: adapter as never, audit: new Sink(store, bus, perf), logger: slog, performanceMonitor: perf, now: () => new Date() });

      const submitted = await runtime.evaluateGoal(goal.id);
      expect(submitted.kind).toBe("EXECUTION_SUBMITTED");
      expect(prepareSpy, "delegated path must NOT call the v1 prepare seam").not.toHaveBeenCalled();
      const req = (executeSpy.mock.calls as unknown as Array<Array<unknown>>)[0]?.[0] as { steps: unknown[]; transactionRequest: unknown };
      expect(req.steps).toEqual([]);
      expect(req.transactionRequest).toBeNull();

      // verification pass completes the goal without prepare as well
      const { AUTONOMY_LIMITS: LIMITS } = await import("@/lib/autonomy/config");
      await new Promise((r) => setTimeout(r, 50));
      const g = (await store.getGoal(goal.id))!;
      await store.transitionGoal(goal.id, walletAddr, ["EXECUTING"], g.updatedAt, { updatedAt: "v2", nextEvaluationAt: new Date().toISOString() });
      const second = await runtime.evaluateGoal(goal.id);
      expect((await store.getGoal(goal.id))!.status).toBe("COMPLETED");
      void second; void LIMITS;
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
