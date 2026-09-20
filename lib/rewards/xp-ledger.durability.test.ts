// Task 6 — ledger durability / permanent idempotency.
//
// Executes the real AWARD_XP_SCRIPT / AWARD_CAPPED_GAME_XP_SCRIPT Lua via
// an in-memory Redis double (lib/__tests__/helpers/lua-redis.ts) instead
// of string-matching the scripts. This is the only way to prove the
// idempotency behaviour over time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

import { LuaRedis } from "@/lib/__tests__/helpers/lua-redis";

const redis = new LuaRedis();
vi.mock("@/lib/api/redis", () => ({ getRedis: () => redis.client() }));

const WALLET = "0xAbC0000000000000000000000000000000000001" as Address;
const wallet = WALLET.toLowerCase();
const DAY = 24 * 60 * 60 * 1000;

async function ledger() {
  return import("./xp-ledger");
}

describe("XP ledger — event idempotency must be permanent", () => {
  beforeEach(() => {
    redis.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("awards a one-time event exactly once and rejects an immediate replay", async () => {
    const { awardServerXP, getTotalXP } = await ledger();
    const first = await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    const replay = await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    expect(first.awarded).toBe(true);
    expect(first.xp).toBe(50);
    expect(replay.awarded).toBe(false);
    expect(replay.xp).toBe(0);
    expect(await getTotalXP(WALLET)).toBe(50);
  });

  it("still rejects the same one-time event after more than 400 days (was re-awardable: TTL on the idempotency key)", async () => {
    const { awardServerXP, getTotalXP } = await ledger();
    await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    expect(await getTotalXP(WALLET)).toBe(50);

    // Real time passes on both the Redis clock and the JS clock.
    redis.advance(401 * DAY);
    vi.setSystemTime(new Date(Date.now() + 401 * DAY));

    const replay = await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    expect(replay.awarded).toBe(false);
    expect(await getTotalXP(WALLET)).toBe(50);
  });

  it("keeps the ledger event record (meta) without a TTL so history is durable", async () => {
    const { awardServerXP } = await ledger();
    await awardServerXP(WALLET, "DAILY_CHECK_IN", "daily-check-in:2026-09-20");
    expect(redis.call(["TTL", `mpgrhub:xp:event:${wallet}:daily-check-in:2026-09-20`])).toBe(-1);
    expect(redis.call(["TTL", `mpgrhub:xp:event-meta:${wallet}:daily-check-in:2026-09-20`])).toBe(-1);
    const meta = JSON.parse(String(redis.call(["GET", `mpgrhub:xp:event-meta:${wallet}:daily-check-in:2026-09-20`])));
    expect(meta).toMatchObject({ wallet, action: "DAILY_CHECK_IN", xp: 20, eventId: "daily-check-in:2026-09-20" });
  });

  it("game XP is idempotent per session forever, and the daily cap key still expires", async () => {
    const { awardCappedGameXP, getTotalXP } = await ledger();
    const first = await awardCappedGameXP(WALLET, "session-1");
    const dup = await awardCappedGameXP(WALLET, "session-1");
    expect(first.awarded).toBe(true);
    expect(dup.awarded).toBe(false);
    expect(dup.dailyCapReached).toBe(false);
    expect(redis.call(["TTL", `mpgrhub:xp:event:${wallet}:game:session-1`])).toBe(-1);
    // Cap key is operational state and keeps its 48h TTL.
    const capTtl = redis.call(["TTL", `mpgrhub:xp:game-cap:${wallet}:2026-09-20`]) as number;
    expect(capTtl).toBeGreaterThan(0);
    expect(capTtl).toBeLessThanOrEqual(48 * 3600);

    redis.advance(401 * DAY);
    vi.setSystemTime(new Date(Date.now() + 401 * DAY));
    const late = await awardCappedGameXP(WALLET, "session-1");
    expect(late.awarded).toBe(false);
    expect(await getTotalXP(WALLET)).toBe(8);
  });

  it("migration: an existing event key that still carries the legacy TTL is made permanent on replay", async () => {
    // Simulate production data written by the previous ledger version:
    // idempotency + meta keys with ~400d TTL and the totals already applied.
    const eventKey = `mpgrhub:xp:event:${wallet}:wallet-connected`;
    const metaKey = `mpgrhub:xp:event-meta:${wallet}:wallet-connected`;
    redis.call(["SET", eventKey, "1", "EX", String(60 * 60 * 24 * 100)]);
    redis.call(["SET", metaKey, JSON.stringify({ wallet, action: "WALLET_CONNECTED", xp: 50, eventId: "wallet-connected" }), "EX", String(60 * 60 * 24 * 100)]);
    redis.call(["INCRBY", `mpgrhub:xp:total:${wallet}`, "50"]);
    redis.call(["ZINCRBY", "mpgrhub:xp:rank", "50", wallet]);

    const { awardServerXP, getTotalXP } = await ledger();
    const replay = await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    expect(replay.awarded).toBe(false);
    expect(await getTotalXP(WALLET)).toBe(50); // total preserved, not double counted

    // The legacy TTL has been removed by the read-old/write-new path.
    expect(redis.call(["TTL", eventKey])).toBe(-1);
    expect(redis.call(["TTL", metaKey])).toBe(-1);

    // …so the event can no longer come back after the legacy expiry.
    redis.advance(101 * DAY);
    vi.setSystemTime(new Date(Date.now() + 101 * DAY));
    const late = await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    expect(late.awarded).toBe(false);
    expect(await getTotalXP(WALLET)).toBe(50);
  });

  it("concurrent duplicate awards (same wallet, same event) credit exactly once", async () => {
    const { awardServerXP, getTotalXP } = await ledger();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => awardServerXP(WALLET, "DAILY_CHECK_IN", "daily-check-in:2026-09-21")),
    );
    expect(results.filter((r) => r.awarded)).toHaveLength(1);
    expect(await getTotalXP(WALLET)).toBe(20);
  });

  it("wallet binding: the same eventId for a different wallet is a different ledger entry", async () => {
    const { awardServerXP, getTotalXP } = await ledger();
    const other = "0xAbC0000000000000000000000000000000000002" as Address;
    await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    const second = await awardServerXP(other, "WALLET_CONNECTED", "wallet-connected");
    expect(second.awarded).toBe(true);
    expect(await getTotalXP(WALLET)).toBe(50);
    expect(await getTotalXP(other)).toBe(50);
  });

  it("wallet case-insensitivity: mixed-case and lower-case address share one ledger", async () => {
    const { awardServerXP, getTotalXP } = await ledger();
    await awardServerXP(WALLET, "WALLET_CONNECTED", "wallet-connected");
    const replay = await awardServerXP(wallet as Address, "WALLET_CONNECTED", "wallet-connected");
    expect(replay.awarded).toBe(false);
    expect(await getTotalXP(wallet as Address)).toBe(50);
  });

  it("rejects malformed events before touching Redis", async () => {
    const { awardServerXP } = await ledger();
    const before = redis.log.length;
    await expect(awardServerXP(WALLET, "WALLET_CONNECTED", "")).rejects.toThrow("Invalid XP event.");
    await expect(awardServerXP(WALLET, "WALLET_CONNECTED", "x".repeat(161))).rejects.toThrow("Invalid XP event.");
    await expect(awardServerXP(WALLET, "NOT_AN_ACTION" as never, "e")).rejects.toThrow("Invalid XP event.");
    expect(redis.log.length).toBe(before);
  });
});
