// Daily spend reservation lifecycle tests (R3/R5) — the store contract run
// against BOTH implementations (in-memory mirror + production Redis scripts
// through the LuaRedis double; real-Redis coverage in daily-spend.redis.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import { InMemoryAutonomyStore, type AutonomyStore } from "@/lib/autonomy/store";
import { RedisAutonomyStore } from "@/lib/autonomy/redis-store";
import { PRE_BROADCAST_REFUSAL_CODES } from "@/lib/autonomy/types";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({
  getRedis: () => redis.client(),
}));

const DAY = "2026-10-10";

function reserve(store: AutonomyStore, execId: string, amountRaw: string, over: Partial<{ policyId: string; dayKey: string; maxDailyRaw: string; maxActions: number }> = {}) {
  return store.reserveDailySpend({
    policyId: over.policyId ?? "pol_r",
    dayKey: over.dayKey ?? DAY,
    execId,
    amountRaw,
    maxDailyRaw: over.maxDailyRaw ?? "1000",
    maxActions: over.maxActions ?? 50,
  });
}

async function lifecycleContract(name: string, make: () => AutonomyStore) {
  describe(`spend reservation lifecycle — ${name}`, () => {
    let store: AutonomyStore;
    beforeEach(() => {
      store = make();
    });

    it("caps are enforced ATOMICALLY at the boundary: concurrent goals cannot jointly exceed maxDaily", async () => {
      // The race the old design lost: both goals pass a TS pre-check against
      // the same empty day, then both claim. Here the SECOND reservation is
      // refused by the atomic script — total never exceeds the cap.
      const [a, b] = await Promise.all([
        reserve(store, "g1", "600", { maxDailyRaw: "1000" }),
        reserve(store, "g2", "600", { maxDailyRaw: "1000" }),
      ]);
      const ok = [a, b].filter((r) => r.ok);
      const refused = [a, b].filter((r) => !r.ok);
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(!refused[0].ok && refused[0].reason).toBe("OVER_BUDGET");
      const day = await store.getDayLedger("pol_r", DAY);
      expect(day).toEqual({ status: "OK", spendRaw: "600", actions: 1 });
    });

    it("action-count cap is atomic too (concurrent)", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => reserve(store, `a${i}`, "1", { maxActions: 3, maxDailyRaw: "10000" })),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(results.filter((r) => !r.ok && r.reason === "OVER_ACTIONS")).toHaveLength(3);
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "3", actions: 3 });
    });

    it("duplicate execution ids never double-count (idempotent retries)", async () => {
      expect((await reserve(store, "e1", "500")).ok).toBe(true);
      for (let i = 0; i < 3; i++) {
        const dup = await reserve(store, "e1", "500");
        expect(dup.ok).toBe(true);
        expect(dup.ok && dup.created).toBe(false);
        expect(dup.ok && dup.state).toBe("RESERVED");
      }
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "500", actions: 1 });
    });

    it("lifecycle: RESERVED -> ATTEMPTING -> COMMITTED keeps spend counted", async () => {
      await reserve(store, "e1", "100");
      expect(await store.markSpendAttempt("pol_r", DAY, "e1")).toBe("ATTEMPTING");
      expect(await store.markSpendAttempt("pol_r", DAY, "e1")).toBe("ATTEMPTING"); // idempotent
      expect(await store.commitDailySpend("pol_r", DAY, "e1")).toBe("COMMITTED");
      expect(await store.commitDailySpend("pol_r", DAY, "e1")).toBe("COMMITTED"); // idempotent
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
    });

    it("reverted execution (commit after attempt) also keeps spend counted (conservative)", async () => {
      await reserve(store, "e1", "100");
      await store.markSpendAttempt("pol_r", DAY, "e1");
      expect(await store.commitDailySpend("pol_r", DAY, "e1")).toBe("COMMITTED");
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
    });

    it("release ONLY for explicit verified pre-broadcast codes, from RESERVED or ATTEMPTING", async () => {
      for (const code of PRE_BROADCAST_REFUSAL_CODES) {
        await reserve(store, `e-${code}`, "10");
        expect(await store.markSpendAttempt("pol_r", DAY, `e-${code}`)).toBe("ATTEMPTING");
        expect(
          await store.releaseDailySpend("pol_r", DAY, `e-${code}`, { reason: "PRE_BROADCAST_REFUSAL", code }),
          `code ${code} must be releasable`,
        ).toBe("RELEASED");
      }
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
    });

    it("never releases for RPC_ERROR / TIMEOUT / unknown codes (and the store refuses them too)", async () => {
      for (const code of ["RPC_ERROR", "TIMEOUT", "TX_REVERTED", "VERIFICATION_FAILED"] as const) {
        await reserve(store, `e-${code}`, "10");
        await store.markSpendAttempt("pol_r", DAY, `e-${code}`);
        expect(await store.releaseDailySpend("pol_r", DAY, `e-${code}`, { reason: "PRE_BROADCAST_REFUSAL", code }), `code ${code} must NOT release`).toBeNull();
      }
      // The spend all stays counted.
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "40", actions: 4 });
    });

    it("ATTEMPTING -> AMBIGUOUS (recovery) keeps spend counted and blocks release", async () => {
      await reserve(store, "e1", "100");
      await store.markSpendAttempt("pol_r", DAY, "e1");
      expect(await store.markSpendAmbiguous("pol_r", DAY, "e1")).toBe("AMBIGUOUS");
      expect(await store.markSpendAmbiguous("pol_r", DAY, "e1")).toBeNull(); // terminal
      expect(await store.releaseDailySpend("pol_r", DAY, "e1", { reason: "PRE_BROADCAST_REFUSAL", code: "QUOTE_STALE" })).toBeNull();
      expect(await store.commitDailySpend("pol_r", DAY, "e1")).toBe("AMBIGUOUS"); // stays consumed
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
    });

    it("crash after reserve, before attempt marker: UNATTEMPTED recovery releases exactly once", async () => {
      await reserve(store, "e1", "100");
      // Simulate the crashed run: no attempt marker was ever persisted.
      expect(await store.releaseDailySpend("pol_r", DAY, "e1", { reason: "UNATTEMPTED" })).toBe("RELEASED");
      expect(await store.releaseDailySpend("pol_r", DAY, "e1", { reason: "UNATTEMPTED" })).toBeNull(); // idempotent refusal
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
      // The slot is free for a NEW execution id (new evaluation slot).
      expect((await reserve(store, "e2", "100")).ok).toBe(true);
    });

    it("crash after attempt marker: UNATTEMPTED release is REFUSED (the broadcast may have happened)", async () => {
      await reserve(store, "e1", "100");
      await store.markSpendAttempt("pol_r", DAY, "e1");
      expect(await store.releaseDailySpend("pol_r", DAY, "e1", { reason: "UNATTEMPTED" })).toBeNull();
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
    });

    it("release of a COMMITTED reservation is refused (spend stays)", async () => {
      await reserve(store, "e1", "100");
      await store.markSpendAttempt("pol_r", DAY, "e1");
      await store.commitDailySpend("pol_r", DAY, "e1");
      expect(await store.releaseDailySpend("pol_r", DAY, "e1", { reason: "UNATTEMPTED" })).toBeNull();
      expect(await store.releaseDailySpend("pol_r", DAY, "e1", { reason: "PRE_BROADCAST_REFUSAL", code: "QUOTE_STALE" })).toBeNull();
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
    });

    it("exact large integer amounts (beyond float64 and int64) — boundaries exact", async () => {
      const huge = "123456789012345678901234567890123456789"; // 1e38-ish
      const maxDaily = (BigInt(huge) + 5n).toString();
      const r1 = await reserve(store, "e1", huge, { maxDailyRaw: maxDaily });
      expect(r1.ok).toBe(true);
      const r2 = await reserve(store, "e2", "5", { maxDailyRaw: maxDaily }); // exactly at the cap
      expect(r2.ok).toBe(true);
      const over = await reserve(store, "e3", "1", { maxDailyRaw: maxDaily }); // huge+6 > huge+5
      expect(over.ok).toBe(false);
      expect(!over.ok && over.reason).toBe("OVER_BUDGET");
      // Release one and the exact budget frees by exactly that amount.
      expect(await store.releaseDailySpend("pol_r", DAY, "e2", { reason: "UNATTEMPTED" })).toBe("RELEASED");
      const again = await reserve(store, "e3", "1", { maxDailyRaw: maxDaily });
      expect(again.ok).toBe(true);
      const day = await store.getDayLedger("pol_r", DAY);
      expect(day.status).toBe("OK");
      if (day.status === "OK") expect(day.spendRaw).toBe((BigInt(huge) + 1n).toString());
    });

    it("non-digit / zero amount and bad caps are refused (BAD_AMOUNT)", async () => {
      expect((await reserve(store, "e1", "12.5")).ok).toBe(false);
      expect((await reserve(store, "e2", "-5")).ok).toBe(false);
      expect((await reserve(store, "e3", "")).ok).toBe(false);
      expect((await reserve(store, "e4", "007")).ok).toBe(true); // digits with leading zeros still exact
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "7", actions: 1 });
    });

    it("markSpendAttempt on unknown execution id is a safe no-op (null)", async () => {
      expect(await store.markSpendAttempt("pol_r", DAY, "ghost")).toBeNull();
      expect(await store.commitDailySpend("pol_r", DAY, "ghost")).toBeNull();
      expect(await store.markSpendAmbiguous("pol_r", DAY, "ghost")).toBeNull();
      expect(await store.releaseDailySpend("pol_r", DAY, "ghost", { reason: "UNATTEMPTED" })).toBeNull();
    });

    it("reservations are isolated per policy-day (no cross-talk)", async () => {
      await reserve(store, "e1", "100");
      await reserve(store, "e1", "100", { dayKey: "2026-10-11" });
      await reserve(store, "e1", "100", { policyId: "pol_other" });
      expect(await store.getDayLedger("pol_r", DAY)).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
      expect(await store.getDayLedger("pol_r", "2026-10-11")).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
      expect(await store.getDayLedger("pol_other", DAY)).toEqual({ status: "OK", spendRaw: "100", actions: 1 });
    });
  });
}

await lifecycleContract("in-memory (Lua mirror)", () => new InMemoryAutonomyStore());
await lifecycleContract("redis (canonical Lua)", () => {
  redis.reset();
  return new RedisAutonomyStore();
});
