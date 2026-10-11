// REAL-REDIS suite for the daily spend reservations + CSV->hash migration
// fence (R3/R4). Runs the CANONICAL Lua from lib/autonomy/day-ledger-scripts.ts
// through RedisAutonomyStore against a real Redis server (CI pins the server
// version in .github/workflows/ci.yml; locally point REDIS_URL at any Redis
// 6.2+ / 7.x).
//
// Opt-in exactly like the repo's other env-gated suites: without REDIS_URL the
// whole suite is SKIPPED (the LuaRedis-double coverage in
// daily-spend-reservations.test.ts / legacy-ledger-migration.test.ts always runs).
//
// Every test uses unique policy/day ids (no FLUSHALL) so a shared REDIS_URL is
// never wiped.
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Redis as Ioredis } from "ioredis";

import {
  DAY_LEDGER_KEYS,
  RESERVE_DAY_SPEND_SCRIPT,
  legacyLedgerPoison,
} from "@/lib/autonomy/day-ledger-scripts";
import { RedisAutonomyStore } from "@/lib/autonomy/redis-store";
import { frozenLegacyAppend, type EvalClient } from "./legacy-writer-fixture";

const REDIS_URL = process.env.REDIS_URL?.trim();
const LIVE = Boolean(REDIS_URL);

/** Upstash-shaped client over an ioredis connection (the store's seam). */
function upstashShim(io: Ioredis) {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const raw = await io.get(key);
      if (raw === null) return null;
      try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
    },
    async set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null> {
      const v = typeof value === "string" ? value : JSON.stringify(value);
      const args: Array<string | number> = [key, v];
      if (opts?.nx) args.push("NX");
      if (opts?.ex !== undefined) args.push("EX", opts.ex);
      const callSet = io.set.bind(io) as unknown as (...a: Array<string | number>) => Promise<unknown>;
      const r = await callSet(...args);
      return r === null ? null : "OK";
    },
    async del(...keys: string[]): Promise<number> { return io.del(...keys); },
    async eval<T = unknown>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
      const callEval = io.eval.bind(io) as unknown as (...a: Array<string | number>) => Promise<unknown>;
      return (await callEval(script, keys.length, ...keys, ...args)) as T;
    },
  };
}

// Filled in beforeAll; the mock factory resolves it lazily at first use.
const live: { io: Ioredis | null; io2: Ioredis | null } = { io: null, io2: null };
vi.mock("@/lib/api/redis", () => ({
  getRedis: () => upstashShim(live.io!),
}));

function ledgerKeys(policyId: string, dayKey: string): string[] {
  return [
    DAY_LEDGER_KEYS.legacy(policyId, dayKey),
    DAY_LEDGER_KEYS.hash(policyId, dayKey),
    DAY_LEDGER_KEYS.fence(policyId, dayKey),
    DAY_LEDGER_KEYS.archive(policyId, dayKey),
    DAY_LEDGER_KEYS.gen(policyId, dayKey),
  ];
}

function ledgerArgs(execId: string, amount: string, maxDaily: string, maxActions: number): Array<string | number> {
  return [legacyLedgerPoison(), 2 * 86_400, 3 * 86_400, execId, amount, maxDaily, maxActions];
}

describe.skipIf(!LIVE)("REAL REDIS — daily spend reservations + migration fence (canonical Lua)", () => {
  let store: RedisAutonomyStore;
  let suffix: string;

  beforeAll(() => {
    live.io = new Ioredis(REDIS_URL!, { maxRetriesPerRequest: 1 });
    live.io2 = new Ioredis(REDIS_URL!, { maxRetriesPerRequest: 1 });
    store = new RedisAutonomyStore();
    suffix = randomBytes(4).toString("hex");
  });

  afterAll(async () => {
    await live.io?.quit();
    await live.io2?.quit();
  });

  const id = (n: string) => ({ policyId: `pol_redis_${n}_${suffix}`, dayKey: "2026-10-10" });

  it("concurrent reservations across TWO connections never jointly exceed maxDaily", async () => {
    const { policyId, dayKey } = id("cap");
    // 10 attempts of 150 against a 1000 cap, alternating connections — the
    // atomic Lua decides; no TS-side pre-check exists in this path at all.
    const attempts = Array.from({ length: 10 }, (_, i) => {
      const shim = upstashShim(i % 2 === 0 ? live.io! : live.io2!);
      return shim.eval<Array<string | number>>(
        RESERVE_DAY_SPEND_SCRIPT,
        ledgerKeys(policyId, dayKey),
        ledgerArgs(`e${i}`, "150", "1000", 50),
      );
    });
    const results = await Promise.all(attempts);
    const created = results.filter((r) => Array.isArray(r) && String(r[0]) === "OK" && String(r[1]) === "1").length;
    expect(created).toBe(6); // 6*150=900 <= 1000; a 7th would be 1050 > 1000
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: "900", actions: 6 });
  });

  it("legacy CSV present -> imported + fenced; frozen old writer refused afterwards", async () => {
    const { policyId, dayKey } = id("mig");
    const legacyKey = DAY_LEDGER_KEYS.legacy(policyId, dayKey);
    const oldClient = upstashShim(live.io!) as unknown as EvalClient;
    // Old-code writer (frozen pre-fix script) admits two actions.
    expect(await frozenLegacyAppend(oldClient, legacyKey, "5", 10)).toEqual(["5"]);
    expect(await frozenLegacyAppend(oldClient, legacyKey, "7", 10)).toEqual(["5", "7"]);
    // First new-code access migrates + fences atomically.
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
    expect(await live.io!.get(legacyKey)).toBe(legacyLedgerPoison());
    // The frozen old writer can no longer admit actions.
    expect(await frozenLegacyAppend(oldClient, legacyKey, "1", 50)).toBeNull();
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
  });

  it("malformed legacy CSV fails closed with zero writes (real Lua validation)", async () => {
    const { policyId, dayKey } = id("bad");
    const legacyKey = DAY_LEDGER_KEYS.legacy(policyId, dayKey);
    await live.io!.set(legacyKey, "1,x,2");
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "MALFORMED_LEGACY", spendRaw: null, actions: null });
    expect(await live.io!.get(legacyKey)).toBe("1,x,2"); // untouched
    expect(await live.io!.exists(DAY_LEDGER_KEYS.fence(policyId, dayKey))).toBe(0); // exists(key) -> 0/1
    const r = await store.reserveDailySpend({ policyId, dayKey, execId: "e1", amountRaw: "5", maxDailyRaw: "100", maxActions: 5 });
    expect(r.ok).toBe(false);
  });

  it("missing hash behind an existing fence -> LEDGER_UNAVAILABLE (never zero) + restore from archive", async () => {
    const { policyId, dayKey } = id("lost");
    const legacyKey = DAY_LEDGER_KEYS.legacy(policyId, dayKey);
    const oldClient = upstashShim(live.io!) as unknown as EvalClient;
    await frozenLegacyAppend(oldClient, legacyKey, "5", 10);
    await frozenLegacyAppend(oldClient, legacyKey, "7", 10);
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
    await live.io!.del(DAY_LEDGER_KEYS.hash(policyId, dayKey)); // ops anomaly
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
    expect(await store.restoreDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: "12", actions: 2 });
  });

  it("restore FAILS CLOSED after post-migration reservations (committed / reserved / ambiguous)", async () => {
    // Regression: restoreDayLedger must never reconstruct a day from the
    // migration archive alone once any post-migration write happened — the
    // archive cannot hold reservations and an archive-only total would
    // UNDERCOUNT daily spend. The daygen write-witness refuses it (fail
    // closed). Three sub-scenarios on real Redis: COMMITTED, RESERVED, AMBIGUOUS.
    const cases = [
      { n: "lost_c", settle: async (p: string, d: string) => { expect(await store.commitDailySpend(p, d, "e1")).toBe("COMMITTED"); } },
      { n: "lost_r", settle: async (_p: string, _d: string) => { /* stays RESERVED */ } },
      {
        n: "lost_x",
        settle: async (p: string, d: string) => {
          expect(await store.markSpendAttempt(p, d, "e1")).toBe("ATTEMPTING");
          expect(await store.markSpendAmbiguous(p, d, "e1")).toBe("AMBIGUOUS");
        },
      },
    ];
    for (const c of cases) {
      const { policyId, dayKey } = id(c.n);
      const oldClient = upstashShim(live.io!) as unknown as EvalClient;
      await frozenLegacyAppend(oldClient, DAY_LEDGER_KEYS.legacy(policyId, dayKey), "5", 10);
      expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: "5", actions: 1 });
      expect((await store.reserveDailySpend({ policyId, dayKey, execId: "e1", amountRaw: "3", maxDailyRaw: "100", maxActions: 5 })).ok).toBe(true);
      await c.settle(policyId, dayKey);
      await live.io!.del(DAY_LEDGER_KEYS.hash(policyId, dayKey)); // ops anomaly
      // Archive ("5") cannot contain e1's 3 — restoring it would undercount 8.
      expect(await store.restoreDayLedger(policyId, dayKey)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
      expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "LEDGER_UNAVAILABLE", spendRaw: null, actions: null });
    }
  });

  it("duplicate execution ids are idempotent (no double-charge) and exact for huge amounts", async () => {
    const { policyId, dayKey } = id("dup");
    const huge = "99999999999999999999999999999999999999"; // 1e39-ish, beyond int64 AND float64
    for (let i = 0; i < 3; i++) {
      const r = await store.reserveDailySpend({ policyId, dayKey, execId: "same", amountRaw: huge, maxDailyRaw: `${huge}0`, maxActions: 5 });
      expect(r.ok).toBe(true);
    }
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: huge, actions: 1 });
  });

  it("lifecycle: ATTEMPTING survives crash semantics; verified release frees exactly", async () => {
    const { policyId, dayKey } = id("life");
    await store.reserveDailySpend({ policyId, dayKey, execId: "e1", amountRaw: "100", maxDailyRaw: "1000", maxActions: 5 });
    expect(await store.markSpendAttempt(policyId, dayKey, "e1")).toBe("ATTEMPTING");
    // Crash recovery must NOT free an attempted reservation…
    expect(await store.releaseDailySpend(policyId, dayKey, "e1", { reason: "UNATTEMPTED" })).toBeNull();
    // …only a verified pre-broadcast refusal does.
    expect(await store.releaseDailySpend(policyId, dayKey, "e1", { reason: "PRE_BROADCAST_REFUSAL", code: "QUOTE_STALE" })).toBe("RELEASED");
    expect(await store.getDayLedger(policyId, dayKey)).toEqual({ status: "OK", spendRaw: "0", actions: 0 });
  });
});
