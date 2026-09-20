// Task 8 — referral abuse hardening (store-level).
//
// Runs the REAL Lua scripts through the fengari Redis double (same harness
// as lib/rewards/xp-ledger.durability.test.ts) so idempotency, atomicity
// and the reward-settlement state machine are proven over actual script
// execution, not string matching.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

// Same wallet, two spellings — proves every comparison/key path normalizes.
function addr(body: string): Address {
  const hex = body.padEnd(40, "0").slice(0, 40);
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error("bad test address " + body);
  return `0x${hex}` as Address;
}
const REFERRER = addr("Aa1111111111111111111111111111111111bB");
const REFERRER_LOWER = REFERRER.toLowerCase() as Address;
const REFERRED = addr("2222222222222222222222222222222222222222");
const OTHER = addr("Bb333333333333333333333333333333333333Cc");

function lower(wallet: string): string {
  return wallet.toLowerCase();
}

async function store() {
  return import("./referral-store");
}

async function ledger() {
  return import("@/lib/rewards/xp-ledger");
}

function refKey(kind: string, wallet: string): string {
  return `mpgrhub:referral:${kind}:${wallet.toLowerCase()}`;
}

function dayId(): string {
  return new Date().toISOString().slice(0, 10);
}

async function totalXp(wallet: string): Promise<number> {
  const value = await redis.client().get<number>(`mpgrhub:xp:total:${wallet.toLowerCase()}`);
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

beforeEach(() => {
  redis.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("referral attribution — existing protections must not regress", () => {
  it("normalizes case (checksummed vs lowercase) before comparing and keying", async () => {
    const { referralStore } = await store();
    const result = await referralStore.registerReferral(REFERRER, REFERRED);
    expect(result.status).toBe("registered");
    // One record, addressable under either spelling.
    expect(await referralStore.getReferralCount(REFERRER)).toBe(1);
    expect(await referralStore.getReferralCount(REFERRER_LOWER)).toBe(1);
    expect(redis.keys().filter((k) => k === refKey("referredby", REFERRED))).toHaveLength(1);
  });

  it("rejects self-referral even when one side is spelled differently", async () => {
    const { referralStore } = await store();
    const result = await referralStore.registerReferral(REFERRER, REFERRER_LOWER);
    expect(result).toEqual({ status: "self-referral" });
    const reversed = await referralStore.registerReferral(REFERRER_LOWER, REFERRER);
    expect(reversed).toEqual({ status: "self-referral" });
    expect(redis.keys().filter((k) => k.startsWith("mpgrhub:referral:referredby:"))).toHaveLength(0);
  });

  it("is first-write-wins: a second referrer can never re-attribute the referred wallet", async () => {
    const { referralStore } = await store();
    const first = await referralStore.registerReferral(REFERRER, REFERRED);
    const steal = await referralStore.registerReferral(OTHER, REFERRED);
    expect(first.status).toBe("registered");
    expect(steal.status).toBe("already-attributed");
    if (steal.status === "already-attributed") expect(steal.referrer).toBe(lower(REFERRER));
    expect(await redis.client().get(refKey("referredby", REFERRED))).toBe(lower(REFERRER));
    expect(await referralStore.getReferralCount(OTHER)).toBe(0);
  });

  it("replaying the same referral never inflates the count (SADD idempotency)", async () => {
    const { referralStore } = await store();
    await referralStore.registerReferral(REFERRER, REFERRED);
    await referralStore.registerReferral(REFERRER, REFERRED);
    await referralStore.registerReferral(REFERRER, REFERRED);
    expect(await referralStore.getReferralCount(REFERRER)).toBe(1);
  });

  it("rejects malformed addresses and writes nothing", async () => {
    const { referralStore } = await store();
    expect(await referralStore.registerReferral("0x123", REFERRED)).toEqual({ status: "invalid" });
    expect(await referralStore.registerReferral("vitalik.eth", REFERRED)).toEqual({ status: "invalid" });
    expect(await referralStore.registerReferral(REFERRER, "")).toEqual({ status: "invalid" });
    expect(redis.keys().filter((k) => k.startsWith("mpgrhub:referral:"))).toHaveLength(0);
  });

  it("attribution and pending records are durable (no TTL) so expiry cannot reopen a replay window", async () => {
    const { referralStore } = await store();
    await referralStore.registerReferral(REFERRER, REFERRED);
    expect(await redis.client().ttl(refKey("referredby", REFERRED))).toBe(-1);
    expect(await redis.client().ttl(refKey("referrals", REFERRER))).toBe(-1);
    expect(await redis.client().ttl(refKey("reward-pending", REFERRED))).toBe(-1);
    // A year later the attribution still blocks re-registration.
    vi.setSystemTime(new Date("2027-09-20T12:00:00.000Z"));
    const late = await referralStore.registerReferral(OTHER, REFERRED);
    expect(late.status).toBe("already-attributed");
  });
});

describe("referral reward settlement — deferred until genuine activity (Task 8)", () => {
  it("registration creates a durable pending record and pays nothing immediately", async () => {
    const { referralStore } = await store();
    const { awardServerXP } = await ledger();
    // Referrer is a real ledger wallet (has prior activity).
    await awardServerXP(REFERRER, "DAILY_CHECK_IN", "daily-check-in:2026-09-19");
    await referralStore.registerReferral(REFERRER, REFERRED);

    const pending = await redis.client().get<{ referrer: string }>(refKey("reward-pending", REFERRED));
    expect(pending?.referrer).toBe(lower(REFERRER));
    expect(await redis.client().ttl(refKey("reward-pending", REFERRED))).toBe(-1);
    expect(await totalXp(REFERRER)).toBe(20); // only its own check-in, no referral XP yet

    const first = await referralStore.settleReferralReward(REFERRED);
    expect(first.status).toBe("not-eligible"); // referred wallet has no genuine activity yet
    expect(await totalXp(REFERRER)).toBe(20);
  });

  it("pays the referrer exactly once when the referred wallet earns a real activity event", async () => {
    const { referralStore } = await store();
    const { awardServerXP } = await ledger();
    await awardServerXP(REFERRER, "DAILY_CHECK_IN", "daily-check-in:2026-09-19");
    await referralStore.registerReferral(REFERRER, REFERRED);

    await referralStore.markReferredActivity(REFERRED);
    const settle = await referralStore.settleReferralReward(REFERRED);
    expect(settle.status).toBe("awarded");
    expect(await totalXp(REFERRER)).toBe(120);
    expect(await redis.client().get(refKey("reward-pending", REFERRED))).toBeNull();

    // Replays — a later activity event, manual retry — must not re-pay.
    await referralStore.markReferredActivity(REFERRED);
    expect((await referralStore.settleReferralReward(REFERRED)).status).toBe("none");
    expect(await totalXp(REFERRER)).toBe(120);
  });

  it("a wallet referred BEFORE this feature shipped (no pending record) is untouched", async () => {
    const { referralStore } = await store();
    // Seed legacy-shaped data exactly as the pre-Task-8 store wrote it.
    await redis.client().set(refKey("referredby", REFERRED), lower(REFERRER));
    redis.call(["SADD", refKey("referrals", REFERRER), lower(REFERRED)]);

    // Old code path already awarded the referrer at registration time: the
    // ledger event key exists. New settlement must not double-credit.
    const { awardServerXP } = await ledger();
    await awardServerXP(REFERRER, "REFERRAL_SUCCESS", `referral:${lower(REFERRED)}`);

    expect(await referralStore.getReferralCount(REFERRER)).toBe(1);
    await referralStore.markReferredActivity(REFERRED);
    const settle = await referralStore.settleReferralReward(REFERRED);
    expect(settle.status).toBe("none");
    expect(await totalXp(REFERRER)).toBe(100);
  });

  it("rewards may only be credited to a referrer that exists in the server ledger", async () => {
    const { referralStore } = await store();
    await referralStore.registerReferral(OTHER, REFERRED); // OTHER has no ledger record at all
    await referralStore.markReferredActivity(REFERRED);

    const settle = await referralStore.settleReferralReward(REFERRED);
    expect(settle.status).toBe("unverified-referrer");
    expect(await totalXp(OTHER)).toBe(0);
    // Pending is retained: once the referrer becomes a real user, a later
    // referred-side activity event settles it.
    expect(await redis.client().get(refKey("reward-pending", REFERRED))).not.toBeNull();

    const { awardServerXP } = await ledger();
    await awardServerXP(OTHER, "DAILY_CHECK_IN", "daily-check-in:2026-09-20");
    const retry = await referralStore.settleReferralReward(REFERRED);
    expect(retry.status).toBe("awarded");
    expect(await totalXp(OTHER)).toBe(120);
  });

  it("caps rewarded referrals per referrer per UTC day (default 5) while attribution stays uncapped", async () => {
    const { referralStore } = await store();
    const { awardServerXP } = await ledger();
    await awardServerXP(REFERRER, "DAILY_CHECK_IN", "daily-check-in:2026-09-19");

    const referredWallets = Array.from({ length: 7 }, (_, i) => addr(`44${i}${"4".repeat(38)}`));
    let awardedCount = 0;
    for (const referred of referredWallets) {
      await referralStore.registerReferral(REFERRER, referred);
      await referralStore.markReferredActivity(referred);
      const settle = await referralStore.settleReferralReward(referred);
      expect(["awarded", "daily-cap"]).toContain(settle.status);
      if (settle.status === "awarded") awardedCount += 1;
    }
    expect(awardedCount).toBe(5);
    expect(await totalXp(REFERRER)).toBe(20 + 5 * 100);
    // Abuse signal is counted for operators (two cap hits).
    const abuse = await redis.client().get<number>(`mpgrhub:referral:abuse:${lower(REFERRER)}:${dayId()}`);
    expect(Number(abuse)).toBe(2);
    // Attribution itself is NOT capped: all 7 sybils still show as referrals…
    expect(await referralStore.getReferralCount(REFERRER)).toBe(7);
    // …but after tomorrow's cap reset, an already-consumed pending cannot pay again.
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
    const afterReset = await referralStore.settleReferralReward(referredWallets[0]);
    expect(afterReset.status).toBe("none");
    expect(await totalXp(REFERRER)).toBe(520);
  });

  it("the cap is honored atomically under concurrent settlement of different referred wallets", async () => {
    vi.stubEnv("REFERRAL_REWARDS_PER_REFERRER_PER_DAY", "3");
    const { referralStore } = await store();
    const { awardServerXP } = await ledger();
    await awardServerXP(REFERRER, "DAILY_CHECK_IN", "daily-check-in:2026-09-19");

    const referred = Array.from({ length: 6 }, (_, i) => addr(`55${i}${"5".repeat(38)}`));
    for (const w of referred) {
      await referralStore.registerReferral(REFERRER, w);
      await referralStore.markReferredActivity(w);
    }
    const results = await Promise.all(referred.map((w) => referralStore.settleReferralReward(w)));
    const awarded = results.filter((r) => r.status === "awarded").length;
    expect(awarded).toBe(3);
    expect(await totalXp(REFERRER)).toBe(20 + 3 * 100);
  });

  it("two concurrent settlements for the SAME referred wallet credit exactly one reward", async () => {
    const { referralStore } = await store();
    const { awardServerXP } = await ledger();
    await awardServerXP(REFERRER, "DAILY_CHECK_IN", "daily-check-in:2026-09-19");
    await referralStore.registerReferral(REFERRER, REFERRED);
    await referralStore.markReferredActivity(REFERRED);

    const [a, b] = await Promise.all([
      referralStore.settleReferralReward(REFERRED),
      referralStore.settleReferralReward(REFERRED),
    ]);
    const statuses = [a.status, b.status].sort();
    // The claim consumes the pending record atomically, so the loser does
    // not even reach the ledger: "none". (If the timing ever interleaves
    // differently, the permanent ledger event key makes the worst case a
    // "duplicate" — both statuses below credit exactly once.)
    expect(statuses).toEqual(["awarded", "none"]);
    expect(statuses.filter((s) => s === "awarded")).toHaveLength(1);
    expect(await totalXp(REFERRER)).toBe(120);
    expect(await redis.client().get(refKey("reward-pending", REFERRED))).toBeNull();
  });

  it("corrupt pending records never crash settlement and are cleaned without crediting anyone", async () => {
    const { referralStore } = await store();
    await redis.client().set(refKey("reward-pending", REFERRED), "{not-json");
    const settle = await referralStore.settleReferralReward(REFERRED);
    expect(settle.status).toBe("error");
    expect(await redis.client().get(refKey("reward-pending", REFERRED))).toBeNull();
    expect(await totalXp(REFERRER)).toBe(0);
  });

  it("settlement never throws when Redis fails (check-in flow must stay available)", async () => {
    const { referralStore } = await store();
    // Seed a real pending record first, then break Redis entirely.
    await referralStore.registerReferral(REFERRER, REFERRED);
    const spy = vi.spyOn(redis, "eval").mockRejectedValue(new Error("redis down"));
    const settle = await referralStore.settleReferralReward(REFERRED);
    expect(settle.status).toBe("error");
    spy.mockRestore();
    // Nothing was credited, nothing was consumed.
    expect(await totalXp(REFERRER)).toBe(0);
    expect(await redis.client().get(refKey("reward-pending", REFERRED))).not.toBeNull();
  });

  it("a Redis failure after the atomic claim keeps the retry path open but can never double-credit", async () => {
    const { referralStore } = await store();
    const { awardServerXP } = await ledger();
    await awardServerXP(REFERRER, "DAILY_CHECK_IN", "daily-check-in:2026-09-19");
    await referralStore.registerReferral(REFERRER, REFERRED);
    await referralStore.markReferredActivity(REFERRED);

    // The claim script succeeds (real one), the ledger award script fails.
    const originalEval = redis.eval.bind(redis);
    let calls = 0;
    const spy = vi.spyOn(redis, "eval").mockImplementation((script, keys, args) => {
      calls += 1;
      if (calls === 1) return originalEval(script, keys, args) as never;
      return Promise.reject(new Error("redis down")) as never;
    });
    const failed = await referralStore.settleReferralReward(REFERRED);
    spy.mockRestore();
    expect(failed.status).toBe("error");
    expect(await totalXp(REFERRER)).toBe(20);
    // The award idempotency key was NOT created, and the settle helper puts
    // the pending record back (SET NX) so a later activity event retries it.
    expect(await redis.client().get(refKey("reward-pending", REFERRED))).not.toBeNull();
    const retry = await referralStore.settleReferralReward(REFERRED);
    expect(retry.status).toBe("awarded");
    expect(await totalXp(REFERRER)).toBe(120);
  });
});
