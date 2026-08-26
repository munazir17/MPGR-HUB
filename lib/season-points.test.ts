// lib/season-points.test.ts
//
// All fixed UTC dates — no `new Date()` used for "now" anywhere below,
// so nothing here is dependent on the machine's current month.

import { describe, expect, it } from "vitest";
import { calculateSeasonPoints, getUTCSeasonStart, getUTCSeasonEnd, getUTCSeasonOrdinal } from "./season-points";

const AUG_24_2026 = new Date(Date.UTC(2026, 7, 24, 12, 0, 0));

function iso(year: number, month0: number, day: number): string {
  return new Date(Date.UTC(year, month0, day)).toISOString();
}

describe("calculateSeasonPoints — canonical spec cases", () => {
  it("affected legacy wallet: 110 lifetime XP, 20 current-month history, no prior season -> 110/110", () => {
    const result = calculateSeasonPoints(110, [{ xp: 20, timestamp: iso(2026, 7, 10) }], AUG_24_2026);
    expect(result.seasonPoints).toBe(110);
    expect(result.recoveredUnhistoriedXp).toBe(90);
  });

  it("fully historied veteran: 130 lifetime XP, 90 prior + 40 current -> 40, no recovery", () => {
    const result = calculateSeasonPoints(
      130,
      [
        { xp: 90, timestamp: iso(2026, 6, 15) },
        { xp: 40, timestamp: iso(2026, 7, 15) },
      ],
      AUG_24_2026
    );
    expect(result.seasonPoints).toBe(40);
    expect(result.recoveredUnhistoriedXp).toBe(0);
  });

  it("previous-season-only wallet: 50 lifetime XP, all from prior season -> 0", () => {
    const result = calculateSeasonPoints(50, [{ xp: 50, timestamp: iso(2026, 6, 15) }], AUG_24_2026);
    expect(result.seasonPoints).toBe(0);
    expect(result.recoveredUnhistoriedXp).toBe(0);
  });

  it("zero-XP wallet: 0 XP, no history -> 0", () => {
    const result = calculateSeasonPoints(0, [], AUG_24_2026);
    expect(result.seasonPoints).toBe(0);
  });
});

describe("calculateSeasonPoints — UTC [start, end) boundary is exact", () => {
  it("uses UTC midnight on the 1st, not local time", () => {
    expect(getUTCSeasonStart(AUG_24_2026).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("getUTCSeasonEnd is the exclusive first instant of the following month", () => {
    expect(getUTCSeasonEnd(AUG_24_2026).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("a timestamp exactly at UTC start counts as current season", () => {
    const result = calculateSeasonPoints(15, [{ xp: 15, timestamp: "2026-08-01T00:00:00.000Z" }], AUG_24_2026);
    expect(result.seasonPoints).toBe(15);
  });

  it("a timestamp one millisecond before UTC start belongs to the previous season", () => {
    const result = calculateSeasonPoints(15, [{ xp: 15, timestamp: "2026-07-31T23:59:59.999Z" }], AUG_24_2026);
    expect(result.seasonPoints).toBe(0);
  });

  it("a timestamp exactly at UTC end is excluded (future, not current-season)", () => {
    const result = calculateSeasonPoints(15, [{ xp: 15, timestamp: "2026-09-01T00:00:00.000Z" }], AUG_24_2026);
    expect(result.seasonPoints).toBe(0);
    expect(result.invalidEntries).toBe(1);
  });

  it("a timestamp one millisecond before UTC end still counts as current season", () => {
    const result = calculateSeasonPoints(15, [{ xp: 15, timestamp: "2026-08-31T23:59:59.999Z" }], AUG_24_2026);
    expect(result.seasonPoints).toBe(15);
  });
});

describe("calculateSeasonPoints — future timestamps never count, and can't be laundered via recovery", () => {
  it("future-only history contributes 0 to season points", () => {
    const result = calculateSeasonPoints(50, [{ xp: 50, timestamp: iso(2026, 8, 5) }], AUG_24_2026); // Sep 5, 2026
    expect(result.seasonPoints).toBe(0);
    expect(result.invalidEntries).toBe(1);
  });

  it("a future entry's xp is still accounted for internally, so it cannot resurface as unhistoried recovery", () => {
    // If the future entry's xp were simply dropped instead of accounted
    // for, lifetimeXp(50) - accountedSum(0) = 50 unhistoried, and with
    // no prior-season evidence, recovery would wrongly turn this into
    // seasonPoints=50. It must not.
    const result = calculateSeasonPoints(50, [{ xp: 50, timestamp: iso(2026, 8, 5) }], AUG_24_2026);
    expect(result.recoveredUnhistoriedXp).toBe(0);
    expect(result.seasonPoints).toBe(0);
  });
});

describe("calculateSeasonPoints — invalid/malformed entries never inflate Season Points", () => {
  it("THE CORE FIX: an invalid-timestamp entry's xp cannot be laundered back in via unhistoried recovery", () => {
    // lifetimeXp=50, 30 valid current-month XP, 20 XP with an invalid
    // timestamp. Must resolve to 30 — NOT 50 (which would happen if the
    // 20 were excluded from accounting entirely, making the resulting
    // "gap" look like innocent legacy unhistoried XP instead of what it
    // actually is: data this function has already decided not to trust.
    const result = calculateSeasonPoints(
      50,
      [
        { xp: 30, timestamp: iso(2026, 7, 10) },
        { xp: 20, timestamp: "not-a-real-date" },
      ],
      AUG_24_2026
    );
    expect(result.seasonPoints).toBe(30);
    expect(result.recoveredUnhistoriedXp).toBe(0);
    expect(result.invalidEntries).toBe(1);
  });

  it("an empty-string timestamp is treated as invalid, not as epoch/now — and contributes nothing to season points", () => {
    const result = calculateSeasonPoints(10, [{ xp: 10, timestamp: "" }], AUG_24_2026);
    expect(result.invalidEntries).toBe(1);
    // The xp amount (10) is still "accounted for" internally (so it
    // can't later resurface via unhistoried recovery — accountedSum
    // equals lifetimeXp here, so there's no gap to recover) but an
    // entry with no trustworthy timestamp never counts directly toward
    // seasonPoints either. Net result: 0, not 10.
    expect(result.seasonPoints).toBe(0);
    expect(result.recoveredUnhistoriedXp).toBe(0);
  });

  it("negative history XP is excluded entirely, not subtracted or laundered", () => {
    const result = calculateSeasonPoints(
      30,
      [
        { xp: 30, timestamp: iso(2026, 7, 5) },
        { xp: -1000, timestamp: iso(2026, 7, 6) },
      ],
      AUG_24_2026
    );
    expect(result.seasonPoints).toBe(30);
    expect(result.seasonPoints).toBeGreaterThanOrEqual(0);
    expect(result.invalidEntries).toBe(1);
  });

  it("NaN/non-number history xp is excluded entirely and never throws", () => {
    expect(() =>
      calculateSeasonPoints(10, [{ xp: NaN, timestamp: iso(2026, 7, 1) }] as never, AUG_24_2026)
    ).not.toThrow();
    const result = calculateSeasonPoints(10, [{ xp: NaN, timestamp: iso(2026, 7, 1) }] as never, AUG_24_2026);
    expect(result.invalidEntries).toBe(1);
  });

  it("mixed valid + invalid history: valid entries still count normally", () => {
    const result = calculateSeasonPoints(
      100,
      [
        { xp: 40, timestamp: iso(2026, 7, 5) }, // current, valid
        { xp: NaN, timestamp: iso(2026, 7, 6) } as never, // unusable amount
      ],
      AUG_24_2026
    );
    // The NaN entry's amount is genuinely unknown (not "accounted for"),
    // so it doesn't prevent the legacy-recovery rule from applying to
    // the resulting gap — this is the SAME rule as the affected-legacy-
    // wallet case above, not a new loophole: an amount we could never
    // account for behaves identically to a wallet that simply has no
    // history at all for that portion of its lifetime XP.
    expect(result.invalidEntries).toBe(1);
    expect(result.seasonPoints).toBe(100);
    expect(result.recoveredUnhistoriedXp).toBe(60);
  });

  it("mixed current + prior season history with an unrelated invalid entry: recovery correctly stays off", () => {
    const result = calculateSeasonPoints(
      200,
      [
        { xp: 5, timestamp: iso(2026, 6, 1) }, // prior-season proof
        { xp: 55, timestamp: iso(2026, 7, 20) }, // current season
        { xp: 40, timestamp: "garbage" }, // invalid timestamp, known amount
      ],
      AUG_24_2026
    );
    expect(result.seasonPoints).toBe(55);
    expect(result.recoveredUnhistoriedXp).toBe(0);
    expect(result.invalidEntries).toBe(1);
  });

  it("history sum greater than lifetime XP never produces a negative season total", () => {
    const result = calculateSeasonPoints(10, [{ xp: 50, timestamp: iso(2026, 7, 1) }], AUG_24_2026);
    expect(result.seasonPoints).toBeGreaterThanOrEqual(0);
    expect(result.seasonPoints).toBe(50);
  });

  it("clamps a negative lifetimeXp to 0 instead of producing a negative season total", () => {
    const result = calculateSeasonPoints(-50, [], AUG_24_2026);
    expect(result.seasonPoints).toBe(0);
  });
});

describe("calculateSeasonPoints — legacy unhistoried XP recovery never over-applies", () => {
  it("does not recover unhistoried XP when ANY valid prior-season row exists, even a small one", () => {
    const result = calculateSeasonPoints(
      200,
      [
        { xp: 5, timestamp: iso(2026, 6, 1) },
        { xp: 55, timestamp: iso(2026, 7, 20) },
      ],
      AUG_24_2026
    );
    expect(result.seasonPoints).toBe(55);
    expect(result.recoveredUnhistoriedXp).toBe(0);
  });
});

describe("calculateSeasonPoints — month/year rollover", () => {
  it("rolls over January -> February", () => {
    const now = new Date(Date.UTC(2026, 1, 5));
    const result = calculateSeasonPoints(
      100,
      [
        { xp: 60, timestamp: iso(2026, 0, 20) },
        { xp: 40, timestamp: iso(2026, 1, 1) },
      ],
      now
    );
    expect(result.seasonPoints).toBe(40);
  });

  it("rolls over December -> January across a year boundary", () => {
    const now = new Date(Date.UTC(2027, 0, 3));
    const result = calculateSeasonPoints(
      100,
      [
        { xp: 70, timestamp: iso(2026, 11, 28) },
        { xp: 30, timestamp: iso(2027, 0, 1) },
      ],
      now
    );
    expect(result.seasonPoints).toBe(30);
  });
});

describe("getUTCSeasonOrdinal — monotonic UTC month index used by lib/leaderboard-store.ts", () => {
  it("increases by exactly 1 across a month boundary", () => {
    const july = getUTCSeasonOrdinal(new Date(Date.UTC(2026, 6, 15)));
    const august = getUTCSeasonOrdinal(new Date(Date.UTC(2026, 7, 15)));
    expect(august).toBe(july + 1);
  });

  it("increases across a year boundary the same as any other month boundary", () => {
    const dec = getUTCSeasonOrdinal(new Date(Date.UTC(2026, 11, 31)));
    const jan = getUTCSeasonOrdinal(new Date(Date.UTC(2027, 0, 1)));
    expect(jan).toBe(dec + 1);
  });
});
