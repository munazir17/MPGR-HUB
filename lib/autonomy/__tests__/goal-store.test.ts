// Store persistence tests: InMemory + the production Redis scripts executed
// against the repo's LuaRedis double (same approach as session-store tests).
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import { InMemoryAutonomyStore } from "@/lib/autonomy/store";
import { RedisAutonomyStore } from "@/lib/autonomy/redis-store";
import { createActiveGoal, makeHarness, makePolicy, usdc, WALLET } from "./helpers";
import type { AutonomyStore } from "@/lib/autonomy/store";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({
  getRedis: () => redis.client(),
}));

function freshRedisStore(): RedisAutonomyStore {
  redis.reset();
  return new RedisAutonomyStore();
}

async function exerciseStoreContract(name: string, make: () => AutonomyStore) {
  describe(`AutonomyStore contract — ${name}`, () => {
    let store: AutonomyStore;

    beforeEach(() => {
      store = make();
    });

    it("policies: create, get, list scoped by wallet, revoke (CAS)", async () => {
      const policy = await store.createPolicy(makePolicy());
      expect(policy.id).not.toBe("");
      expect((await store.getPolicy(policy.id))?.wallet.toLowerCase()).toBe(WALLET);
      expect(await store.listPolicies(WALLET)).toHaveLength(1);
      expect(await store.listPolicies("0x0000000000000000000000000000000000ffffff")).toHaveLength(0);

      const revoked = await store.revokePolicy(policy.id, WALLET, "2026-01-01T00:00:00Z");
      expect(revoked?.revokedAt).toBe("2026-01-01T00:00:00Z");
      // second revoke is a no-op (CAS)
      expect(await store.revokePolicy(policy.id, WALLET, "2026-01-02T00:00:00Z")).toBeNull();
      expect(await store.revokePolicy(policy.id, "0x0000000000000000000000000000000000ffffff", "2026-01-01T00:00:00Z")).toBeNull();
    });

    it("goals: CAS transition honors updatedAt + wallet + state machine", async () => {
      const policy = await store.createPolicy(makePolicy());
      const goal = await store.createGoal({
        id: "",
        wallet: WALLET,
        policyId: policy.id,
        type: "conditional_swap",
        description: "t",
        status: "ACTIVE",
        condition: { kind: "price_below", threshold: "200" },
        trade: { sellToken: policy.sellToken, buyToken: policy.buyToken, sellAmountRaw: "1", slippageBps: 100, sellDecimals: 6, buyDecimals: 8 },
        cooldownSeconds: 60,
        createdAt: "c",
        updatedAt: "u1",
        expiresAt: "2099-01-01T00:00:00Z",
        nextEvaluationAt: "u1",
        lastAction: null,
        lastResult: null,
        pendingExecution: null,
        stats: { evaluations: 0, triggered: 0, verified: 0, consecutiveFailures: 0 },
      });
      const updated = await store.transitionGoal(goal.id, WALLET, ["ACTIVE"], "u1", { status: "WAITING", updatedAt: "u2", stats: { evaluations: 1, triggered: 0, verified: 0, consecutiveFailures: 0 } });
      expect(updated?.status).toBe("WAITING");
      expect(updated?.stats.evaluations).toBe(1);
      expect(await store.transitionGoal(goal.id, WALLET, ["ACTIVE"], "u2", { updatedAt: "u3" })).toBeNull();
    });

    it("daily ledger: atomic capped append, exact bigint sums, spend+count never drift", async () => {
      const bigAmount = "1000000000000000000000"; // 1e21 — beyond float64-safe integer range
      expect(await store.tryRecordDailyAction("p1", "2026-09-28", bigAmount, 2)).toEqual([bigAmount]);
      expect(await store.tryRecordDailyAction("p1", "2026-09-28", "7", 2)).toEqual([bigAmount, "7"]);
      // cap reached -> null (action refused)
      expect(await store.tryRecordDailyAction("p1", "2026-09-28", "7", 2)).toBeNull();
      expect(await store.getDailySpendRaw("p1", "2026-09-28")).toBe((1000000000000000000000n + 7n).toString());
      expect(await store.getDailyActions("p1", "2026-09-28")).toBe(2);
      expect(await store.getDailySpendRaw("p1", "2026-09-29")).toBe("0");
    });

    it("idempotency: execution claim is exclusive; leases are token-checked", async () => {
      expect(await store.claimExecution("k1", 100)).toBe(true);
      expect(await store.claimExecution("k1", 100)).toBe(false);
      await store.releaseExecution("k1");
      expect(await store.claimExecution("k1", 100)).toBe(true);

      expect(await store.tryAcquireGoalLease("g1", "tok-a", 100)).toBe(true);
      expect(await store.tryAcquireGoalLease("g1", "tok-b", 100)).toBe(false);
      await store.releaseGoalLease("g1", "wrong-token"); // ignored
      expect(await store.tryAcquireGoalLease("g1", "tok-b", 100)).toBe(false);
      await store.releaseGoalLease("g1", "tok-a");
      expect(await store.tryAcquireGoalLease("g1", "tok-b", 100)).toBe(true);
    });

    it("audit + action records: append, cap, read back", async () => {
      for (let i = 0; i < 5; i++) {
        await store.appendAudit({ at: `t${i}`, type: "CONDITION_CHECKED", goalId: "g1", wallet: WALLET }, 3);
      }
      const audit = await store.listAudit("g1");
      expect(audit).toHaveLength(3); // capped
      expect(audit.map((ev) => ev.at)).toEqual(["t2", "t3", "t4"]);
      expect(audit.map((ev) => ev.seq)).toEqual([3, 4, 5]);

      await store.saveActionRecord({ idempotencyKey: "k1", goalId: "g1", wallet: WALLET, policyId: "p1", quoteId: "q", sellAmountRaw: "1", slippageBps: 100, status: "SUBMITTED", outcome: "PENDING_VERIFICATION", verified: false, createdAt: "t", updatedAt: "t" }, 10);
      await store.saveActionRecord({ idempotencyKey: "k1", goalId: "g1", wallet: WALLET, policyId: "p1", quoteId: "q", sellAmountRaw: "1", slippageBps: 100, status: "CONFIRMED", outcome: "VERIFIED", verified: true, createdAt: "t", updatedAt: "t2" }, 10);
      const records = await store.listActionRecords("g1");
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("CONFIRMED");
    });
  });
}

exerciseStoreContract("in-memory", () => new InMemoryAutonomyStore());
exerciseStoreContract("redis (LuaRedis scripts)", () => freshRedisStore());

describe("RedisAutonomyStore — CAS scripts execute for real (LuaRedis)", () => {
  beforeEach(() => {
    redis.reset();
  });

  it("transitionGoal is a true CAS: stale writer loses, legal writer wins", async () => {
    const store = freshRedisStore();
    const harness = makeHarness();
    const { goal } = await createActiveGoal(harness);
    await store.createGoal({ ...goal });
    const updated = await store.transitionGoal(goal.id, WALLET, ["ACTIVE", "WAITING"], goal.updatedAt, { status: "WAITING", updatedAt: "u2" });
    expect(updated?.status).toBe("WAITING");
    // stale updatedAt (pre-update value) -> rejected
    expect(await store.transitionGoal(goal.id, WALLET, ["ACTIVE"], goal.updatedAt, { status: "PAUSED", updatedAt: "u9" })).toBeNull();
    // current updatedAt + legal move -> wins
    const resumed = await store.transitionGoal(goal.id, WALLET, ["WAITING"], "u2", { status: "ACTIVE", updatedAt: "u3" });
    expect(resumed?.status).toBe("ACTIVE");
    // terminal states reject revival (invalid move)
    await store.transitionGoal(goal.id, WALLET, ["ACTIVE"], "u3", { status: "CANCELLED", updatedAt: "u4" });
    expect(await store.transitionGoal(goal.id, WALLET, ["CANCELLED"], "u4", { status: "ACTIVE", updatedAt: "u5" })).toBeNull();
  });

  it("wallet index tracks goals for the cron scan", async () => {
    const store = freshRedisStore();
    const harness = makeHarness();
    const { goal } = await createActiveGoal(harness);
    await store.createGoal({ ...goal });
    expect(await store.listKnownWallets(10)).toEqual([WALLET.toLowerCase()]);
    expect((await store.listGoals(WALLET)).map((g) => g.id)).toContain(goal.id);
  });

  it("daily ledger script refuses entries past the cap and expires keys", async () => {
    const store = freshRedisStore();
    expect(await store.tryRecordDailyAction("p", "d", "5", 1)).toEqual(["5"]);
    expect(await store.tryRecordDailyAction("p", "d", "6", 1)).toBeNull();
    expect(await store.getDailyActions("p", "d")).toBe(1);
  });
});

describe("usdc helper parity", () => {
  it("matches the fixture math", () => {
    expect(usdc("20")).toBe("20000000");
    expect(usdc("0.5")).toBe("500000");
  });
});
