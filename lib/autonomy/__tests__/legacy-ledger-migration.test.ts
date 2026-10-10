// Legacy CSV -> hash migration fence tests (R4).
//
// Contract suite run against BOTH store implementations (in-memory mirror and
// the production Redis scripts through the LuaRedis double), plus real-Redis
// coverage in daily-spend.redis.test.ts. The old writer is the frozen pre-fix
// fixture (legacy-writer-fixture.ts) — exactly what rolling-deploy old-code
// instances would do to the legacy key.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";
import {
  DAY_LEDGER_KEYS,
  LEGACY_LEDGER_POISON_FIELD,
  legacyLedgerPoison,
} from "@/lib/autonomy/day-ledger-scripts";
import { InMemoryAutonomyStore, type DayLedgerSnapshot, type ReserveDailySpendResult } from "@/lib/autonomy/store";
import { RedisAutonomyStore } from "@/lib/autonomy/redis-store";
import {
  frozenLegacyAppend,
  frozenLegacyAppendInMemory,
  frozenLegacyParse,
  type EvalClient,
} from "./legacy-writer-fixture";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({
  getRedis: () => redis.client(),
}));

const DAY = "2026-10-10";
const POLICY = "pol_mig";
const CAP = { maxDailyRaw: "1000", maxActions: 5 };

interface StoreFixture {
  name: string;
  store: InMemoryAutonomyStore | RedisAutonomyStore;
  /** Frozen pre-fix writer against the legacy key of `day`. */
  oldWrite: (amountRaw: string, maxActions: number, day?: string) => Promise<string[] | null>;
  /** Raw view of the legacy key (pre-fix reader semantics: filtered digits). */
  oldRead: () => Promise<string[]>;
  rawLegacy: () => Promise<string | null>;
  setRawLegacy: (value: string) => Promise<unknown>;
  deleteLegacy: () => Promise<unknown>;
  deleteHash: () => Promise<unknown>;
  deleteFence: () => Promise<unknown>;
  restoreDayLedger: () => Promise<DayLedgerSnapshot>;
}

function redisFixture(): StoreFixture {
  redis.reset();
  const store = new RedisAutonomyStore();
  const client = redis.client() as unknown as EvalClient & { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown, o?: { ex?: number }): Promise<unknown>; del(...k: string[]): Promise<number> };
  return {
    name: "redis (canonical Lua)",
    store,
    oldWrite: (amount, maxActions, day = DAY) => frozenLegacyAppend(client, DAY_LEDGER_KEYS.legacy(POLICY, day), amount, maxActions),
    oldRead: async () => frozenLegacyParse(((await client.get<string>(DAY_LEDGER_KEYS.legacy(POLICY, DAY))) ?? null) as string | null),
    rawLegacy: () => client.get<string>(DAY_LEDGER_KEYS.legacy(POLICY, DAY)),
    setRawLegacy: (v) => client.set(DAY_LEDGER_KEYS.legacy(POLICY, DAY), v) as Promise<unknown>,
    deleteLegacy: () => client.del(DAY_LEDGER_KEYS.legacy(POLICY, DAY)) as Promise<unknown>,
    deleteHash: () => client.del(DAY_LEDGER_KEYS.hash(POLICY, DAY)) as Promise<unknown>,
    deleteFence: () => client.del(DAY_LEDGER_KEYS.fence(POLICY, DAY)) as Promise<unknown>,
    restoreDayLedger: () => store.restoreDayLedger(POLICY, DAY),
  };
}

function memoryFixture(): StoreFixture {
  const store = new InMemoryAutonomyStore();
  const key = `${POLICY}:${DAY}`;
  return {
    name: "in-memory (Lua mirror)",
    store,
    oldWrite: (amount, maxActions, day = DAY) => Promise.resolve(frozenLegacyAppendInMemory(store, POLICY, day, amount, maxActions)),
    oldRead: async () => frozenLegacyParse(store.legacyDayLedgers.get(key) ?? null),
    rawLegacy: async () => store.legacyDayLedgers.get(key) ?? null,
    setRawLegacy: (v) => { store.legacyDayLedgers.set(key, v); return Promise.resolve(true); },
    deleteLegacy: () => { store.legacyDayLedgers.delete(key); return Promise.resolve(true); },
    deleteHash: () => { store.dayHashes.delete(key); return Promise.resolve(true); },
    deleteFence: () => { store.dayFences.delete(key); return Promise.resolve(true); },
    restoreDayLedger: () => store.restoreDayLedger(POLICY, DAY),
  };
}

function reserve(fx: StoreFixture, execId: string, amountRaw: string): Promise<ReserveDailySpendResult> {
  return fx.store.reserveDailySpend({ policyId: POLICY, dayKey: DAY, execId, amountRaw, ...CAP });
}

function migrationContract(make: () => StoreFixture) {
  describe(`CSV -> hash migration fence — ${make().name}`, () => {
    let fx: StoreFixture;
    beforeEach(() => { fx = make(); });

    it("legacy CSV present: imports totals, creates fence+poison+archive atomically, old data preserved", async () => {
      await fx.oldWrite("5", 10);
      await fx.oldWrite("7", 10);
      expect(await fx.oldRead()).toEqual(["5", "7"]);
      const day = await fx.store.getDayLedger(POLICY, DAY);
      expect(day).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
      // The legacy key is now poisoned (old writers refused)…
      expect(await fx.rawLegacy()).toBe(legacyLedgerPoison());
      // …and the original CSV is archived for recovery.
      const archive = await fx.rawLegacy();
      expect(archive).toContain(LEGACY_LEDGER_POISON_FIELD);
      // Reservations add on top of the imported legacy sum.
      expect((await reserve(fx, "e1", "3")).ok).toBe(true);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "15", actions: 3 });
    });

    it("legacy CSV absent (fresh day): fenced zero ledger — and the old writer canNOT start a fresh CSV", async () => {
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
      expect(await fx.rawLegacy()).toBe(legacyLedgerPoison());
      // Old-code append against the missing key used to START A NEW CSV and
      // admit actions; after the fence it is refused.
      expect(await fx.oldWrite("999", 50)).toBeNull();
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
    });

    it("old writer after fencing: every legal cap is refused, admitting no actions", async () => {
      await fx.store.getDayLedger(POLICY, DAY); // establishes the fence
      for (const cap of [1, 5, 50]) {
        expect(await fx.oldWrite("1", cap), `old writer with cap ${cap} must be refused`).toBeNull();
      }
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
    });

    it("malformed legacy CSV: fails closed with ZERO writes — no partial migration, no reset", async () => {
      await fx.setRawLegacy("1,x,2");
      const day = await fx.store.getDayLedger(POLICY, DAY);
      expect(day.status).toBe("MALFORMED_LEGACY");
      // NOTHING was written: no poison, no fence, no hash — data intact for
      // a human to fix and retry.
      expect(await fx.rawLegacy()).toBe("1,x,2");
      const again = await fx.store.getDayLedger(POLICY, DAY);
      expect(again.status).toBe("MALFORMED_LEGACY");
      // A reservation refuses too (fail closed).
      const r = await reserve(fx, "e1", "5");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe("MALFORMED_LEGACY");
      // Operator fixes the legacy data -> migration proceeds normally.
      await fx.setRawLegacy("1,2");
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "3", actions: 2 });
    });

    it("empty fields in the legacy CSV (\"1,,2\" / trailing comma) are malformed — fail closed", async () => {
      for (const bad of ["1,,2", "1,2,", ",1", ""]) {
        if (bad === "") continue; // an EMPTY value is a zero-entry ledger, covered below
        await fx.setRawLegacy(bad);
        expect((await fx.store.getDayLedger(POLICY, DAY)).status, `csv=${JSON.stringify(bad)}`).toBe("MALFORMED_LEGACY");
      }
      await fx.setRawLegacy("");
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
    });

    it("migration retries are idempotent: totals are never double-imported", async () => {
      await fx.oldWrite("5", 10);
      await fx.oldWrite("7", 10);
      const first = await fx.store.getDayLedger(POLICY, DAY);
      const second = await fx.store.getDayLedger(POLICY, DAY);
      const third = await reserve(fx, "e1", "1");
      expect(third.ok).toBe(true);
      expect(first).toEqual(second);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "13", actions: 3 });
    });

    it("never resets an existing total when the legacy key is missing (hash wins, no zeroing)", async () => {
      expect((await reserve(fx, "e1", "5")).ok).toBe(true);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "5", actions: 1 });
      // The poisoned legacy key disappears (TTL skew / ops) — the fenced hash
      // is authoritative; totals must NOT reset to zero.
      await fx.deleteLegacy();
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "5", actions: 1 });
    });

    it("missing hash behind an existing fence: LEDGER_UNAVAILABLE (never zero) — restore from archive", async () => {
      await fx.oldWrite("5", 10);
      await fx.oldWrite("7", 10);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
      await fx.deleteHash();
      // Totals are UNKNOWN — the store refuses instead of inventing a zero.
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
      const r = await reserve(fx, "e1", "1");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe("LEDGER_UNAVAILABLE");
      // Operator recovery: rebuild from the migration archive.
      expect(await fx.restoreDayLedger()).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
      expect((await reserve(fx, "e1", "1")).ok).toBe(true);
    });

    it("hash loss after a COMMITTED post-migration reservation: restore FAILS CLOSED (archive cannot undercount)", async () => {
      await fx.oldWrite("5", 10);
      await fx.oldWrite("7", 10);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
      const r = await reserve(fx, "e1", "3");
      expect(r.ok).toBe(true);
      await fx.store.commitDailySpend(POLICY, DAY, "e1");
      await fx.deleteHash();
      // The archive holds only the pre-migration CSV ("12") — restoring it
      // would erase e1's 3 and UNDERCOUNT the day (12 < 15). The write-witness
      // proves post-import writes existed: fail closed, never an incomplete total.
      expect(await fx.restoreDayLedger()).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
      // The ledger stays fail-closed for readers and writers — no resurrection
      // of the archive-only total, no silent zero.
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
      const retry = await reserve(fx, "e2", "1");
      expect(retry.ok).toBe(false);
      expect(!retry.ok && retry.reason).toBe("LEDGER_UNAVAILABLE");
    });

    it("hash loss after a RESERVED (unattempted) post-migration reservation: restore FAILS CLOSED", async () => {
      await fx.oldWrite("5", 10);
      await fx.oldWrite("7", 10);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
      const r = await reserve(fx, "e1", "3");
      expect(r.ok).toBe(true); // RESERVED — counted, may yet be spent
      await fx.deleteHash();
      // The reserved amount must stay counted somewhere. An archive-only
      // restore (12) would undercount the in-flight commitment (15).
      expect(await fx.restoreDayLedger()).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
    });

    it("hash loss after an AMBIGUOUS post-migration reservation: restore FAILS CLOSED (uncertain spend stays counted)", async () => {
      await fx.oldWrite("5", 10);
      await fx.oldWrite("7", 10);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
      const r = await reserve(fx, "e1", "3");
      expect(r.ok).toBe(true);
      expect(await fx.store.markSpendAttempt(POLICY, DAY, "e1")).toBe("ATTEMPTING");
      expect(await fx.store.markSpendAmbiguous(POLICY, DAY, "e1")).toBe("AMBIGUOUS");
      await fx.deleteHash();
      // AMBIGUOUS spend may have hit the chain — it must never fall out of the
      // day total. Archive-only restore (12) would undercount the uncertain 15.
      expect(await fx.restoreDayLedger()).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
    });

    it("hash+fence loss with a write-witness present: never re-imported, never zeroed (fail closed)", async () => {
      await fx.oldWrite("5", 10);
      await fx.oldWrite("7", 10);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
      expect((await reserve(fx, "e1", "3")).ok).toBe(true); // total 15, witness > 0
      await fx.deleteHash();
      await fx.deleteFence();
      await fx.deleteLegacy(); // worst case: hash AND fence AND poison all gone
      // First access must NOT treat this as a fresh day: the witness proves a
      // migration happened, so neither an archive-only re-import (12) nor a
      // zero reset (0) is acceptable — the total is UNKNOWN and stays closed.
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
    });

    it("stale legacy write after fencing is ignored — totals unchanged", async () => {
      expect((await reserve(fx, "e1", "5")).ok).toBe(true);
      // A stale raw write overwrites the poisoned key (worst case).
      await fx.setRawLegacy("1000000");
      // The fence is authoritative: the stale CSV is NOT re-imported.
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "5", actions: 1 });
      // And an old-script append is still refused while the poison is in place.
      await fx.setRawLegacy(legacyLedgerPoison());
      expect(await fx.oldWrite("1", 50)).toBeNull();
    });

    it("concurrent old/new writers: whichever order, no write is lost and the cap holds", async () => {
      // Order A: old append lands first -> imported; new reservation refused
      // by the (now stricter) total; old writer refused after the fence.
      await fx.oldWrite("400", 10);
      expect((await reserve(fx, "e1", "400")).ok).toBe(true); // total 800
      const over = await reserve(fx, "e2", "300"); // 1100 > 1000
      expect(over.ok).toBe(false);
      expect(!over.ok && over.reason).toBe("OVER_BUDGET");
      expect(await fx.oldWrite("1", 10)).toBeNull(); // fenced
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({ status: "OK", spendRaw: "800", actions: 2 });

      // Order B (fresh day): new reserve fences first -> old append refused;
      // the old writer can never sneak spend past the migrated total.
      const DAY2 = "2026-10-11";
      const r1 = await fx.store.reserveDailySpend({ policyId: POLICY, dayKey: DAY2, execId: "n1", amountRaw: "900", ...CAP });
      expect(r1.ok).toBe(true);
      expect(await fx.oldWrite("900", 10, DAY2)).toBeNull();
      expect(await fx.store.getDayLedger(POLICY, DAY2)).toEqual({ status: "OK", spendRaw: "900", actions: 1 });
    });

    it("exact large integer amounts survive migration and reservation (no float64 anywhere)", async () => {
      const huge = "123456789012345678901234567890"; // 1e29-ish, far beyond 2^53
      await fx.setRawLegacy(`${huge},1`);
      expect(await fx.store.getDayLedger(POLICY, DAY)).toEqual({
        status: "OK",
        spendRaw: (BigInt(huge) + 1n).toString(),
        actions: 2,
      });
      const r = await fx.store.reserveDailySpend({
        policyId: POLICY, dayKey: DAY, execId: "e1",
        amountRaw: "9", maxDailyRaw: (BigInt(huge) + 10n).toString(), maxActions: 5,
      });
      expect(r.ok).toBe(true);
      expect(r.ok && r.snapshot.spendRaw).toBe((BigInt(huge) + 10n).toString());
    });
  });
}

migrationContract(memoryFixture);
migrationContract(redisFixture);
