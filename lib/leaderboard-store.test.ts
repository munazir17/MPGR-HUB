// lib/leaderboard-store.test.ts
//
// Verifies upsertEntry()'s stale-write guard against BOTH failure modes
// it's designed to catch:
//   1. a plain xp regression (lower xp arriving after a higher one), and
//   2. a same-xp season-rollover regression (an older season's
//      seasonOrdinal arriving after a newer one, with xp unchanged) —
//      the case a plain xp-only comparison cannot detect.
// Also verifies a legitimate same-xp rollover is NOT blocked, and that
// pre-migration records with no stored seasonOrdinal never get stuck.
//
// @upstash/redis is mocked entirely — this test never touches a real
// Redis instance.

import { describe, expect, it, vi, beforeEach } from "vitest";

const zadd = vi.fn(async () => 1);
const set = vi.fn(async () => "OK");
const get = vi.fn(async () => null as unknown);
const zrange = vi.fn(async () => [] as string[]);
const zrevrank = vi.fn(async () => null as number | null);
const zcard = vi.fn(async () => 0);

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn().mockImplementation(() => ({ zadd, set, get, zrange, zrevrank, zcard })),
}));

// leaderboard-store.ts throws at import time if these are missing.
process.env.UPSTASH_REDIS_REST_URL = "https://example-test.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

const WALLET = "0xAAA0000000000000000000000000000000000AAA";
const AUG_2026_ORDINAL = 2026 * 12 + 7; // matches lib/season-points.ts's getUTCSeasonOrdinal for August
const SEP_2026_ORDINAL = AUG_2026_ORDINAL + 1;

describe("leaderboardStore.upsertEntry — stale-write guard", () => {
  beforeEach(() => {
    zadd.mockClear();
    set.mockClear();
    get.mockClear();
  });

  it("writes normally when there is no existing entry for the wallet", async () => {
    const { leaderboardStore } = await import("./leaderboard-store");
    get.mockResolvedValueOnce(null);

    await leaderboardStore.upsertEntry(WALLET, 100, 20, AUG_2026_ORDINAL);

    expect(zadd).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("writes normally when the incoming xp is higher than what's stored", async () => {
    const { leaderboardStore } = await import("./leaderboard-store");
    get.mockResolvedValueOnce({ xp: 100, seasonPoints: 20, seasonOrdinal: AUG_2026_ORDINAL, updatedAt: new Date().toISOString() });

    await leaderboardStore.upsertEntry(WALLET, 150, 70, AUG_2026_ORDINAL);

    expect(zadd).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("skips the write when the incoming xp is LOWER than what's already stored (stale/out-of-order sync)", async () => {
    const { leaderboardStore } = await import("./leaderboard-store");
    get.mockResolvedValueOnce({ xp: 150, seasonPoints: 70, seasonOrdinal: AUG_2026_ORDINAL, updatedAt: new Date().toISOString() });

    // Simulates the xp=100 request's response landing AFTER the xp=150
    // request's response already wrote the higher value.
    await leaderboardStore.upsertEntry(WALLET, 100, 20, AUG_2026_ORDINAL);

    expect(zadd).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("accepts a legitimate same-xp season rollover (seasonPoints resets to 0, seasonOrdinal advances)", async () => {
    const { leaderboardStore } = await import("./leaderboard-store");
    get.mockResolvedValueOnce({ xp: 150, seasonPoints: 70, seasonOrdinal: AUG_2026_ORDINAL, updatedAt: new Date().toISOString() });

    await leaderboardStore.upsertEntry(WALLET, 150, 0, SEP_2026_ORDINAL);

    expect(zadd).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("THE CORE FIX: rejects a same-xp write from an OLDER season arriving after a newer one already wrote", async () => {
    // Request A computed pre-rollover (seasonOrdinal=AUG, seasonPoints=70).
    // Request B computed post-rollover (seasonOrdinal=SEP, seasonPoints=0)
    // and its response reaches Redis FIRST, correctly storing SEP/0.
    // A's response then arrives late. A plain xp-only guard (xp is equal
    // in both) would NOT catch this — it must be rejected because its
    // seasonOrdinal is older than what's already stored.
    const { leaderboardStore } = await import("./leaderboard-store");
    get.mockResolvedValueOnce({ xp: 100, seasonPoints: 0, seasonOrdinal: SEP_2026_ORDINAL, updatedAt: new Date().toISOString() });

    await leaderboardStore.upsertEntry(WALLET, 100, 70, AUG_2026_ORDINAL);

    expect(zadd).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("accepts a same-xp, same-season re-sync (no rollover, no regression — an ordinary duplicate sync)", async () => {
    const { leaderboardStore } = await import("./leaderboard-store");
    get.mockResolvedValueOnce({ xp: 100, seasonPoints: 40, seasonOrdinal: AUG_2026_ORDINAL, updatedAt: new Date().toISOString() });

    await leaderboardStore.upsertEntry(WALLET, 100, 45, AUG_2026_ORDINAL);

    expect(zadd).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("a pre-migration record with no stored seasonOrdinal never blocks the next write", async () => {
    const { leaderboardStore } = await import("./leaderboard-store");
    // Legacy meta written before this field existed.
    get.mockResolvedValueOnce({ xp: 100, seasonPoints: 40, updatedAt: new Date().toISOString() });

    await leaderboardStore.upsertEntry(WALLET, 100, 0, AUG_2026_ORDINAL);

    expect(zadd).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
