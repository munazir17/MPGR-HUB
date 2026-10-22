// Offline tests for the deterministic coverage probe plan.
//
// The plan is what makes sharding sound: if two shards could own the same pair, or
// a pair could belong to no shard, the merged matrix would silently be smaller than
// the claim it is used to support. These tests use no RPC and no clock.
import { describe, expect, it } from "vitest";
import {
  COVERAGE_MPGR, COVERAGE_USDC, COVERAGE_WETH, coveragePairId, coveragePairPlan, coverageProbeTokens, coverageShard,
} from "../coverage-plan";

const lc = (a: string): string => a.toLowerCase();
const tokens = coverageProbeTokens();
const plan = coveragePairPlan(tokens, 12);

describe("coverageProbeTokens", () => {
  it("includes MPGR first — an imported address no catalog lists", () => {
    expect(lc(tokens[0].address)).toBe(lc(COVERAGE_MPGR));
    expect(tokens[0].symbol).toBe("MPGR");
  });

  it("is deduplicated by address and never empty", () => {
    const addresses = tokens.map((t) => lc(t.address));
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses.length).toBeGreaterThan(10);
    expect(addresses).toContain(lc(COVERAGE_WETH));
    expect(addresses).toContain(lc(COVERAGE_USDC));
  });
});

describe("coveragePairPlan", () => {
  it("is deterministic: same tokens in, same indices out", () => {
    const again = coveragePairPlan(coverageProbeTokens(), 12);
    expect(again).toEqual(plan);
    expect(again.map((p) => p.index)).toEqual(plan.map((p) => p.index));
  });

  it("indices are dense and ascending, so `index % shards` partitions the plan", () => {
    plan.forEach((pair, i) => expect(pair.index).toBe(i));
  });

  it("probes MPGR against both quote assets in BOTH directions, labelled SELL and BUY", () => {
    // MPGR is also the `from` side of arbitrary token/token probes (it is the first
    // token in the list), so the quote-asset probes are selected by direction.
    const mpgr = plan.filter((p) => lc(p.subject) === lc(COVERAGE_MPGR) && p.direction !== "TOKEN_PAIR");
    expect(mpgr).toHaveLength(4);
    const sell = mpgr.filter((p) => p.direction === "SELL");
    const buy = mpgr.filter((p) => p.direction === "BUY");
    expect(sell).toHaveLength(2);
    expect(buy).toHaveLength(2);
    for (const p of sell) {
      expect(lc(p.from)).toBe(lc(COVERAGE_MPGR));
      expect([lc(COVERAGE_USDC), lc(COVERAGE_WETH)]).toContain(lc(p.to));
    }
    for (const p of buy) {
      expect(lc(p.to)).toBe(lc(COVERAGE_MPGR));
      expect([lc(COVERAGE_USDC), lc(COVERAGE_WETH)]).toContain(lc(p.from));
    }
  });

  it("emits each probe once — WETH/USDC is not measured twice from both sides", () => {
    const ids = plan.map((p) => coveragePairId(p.from, p.to));
    expect(new Set(ids).size, "duplicate probe in the plan").toBe(ids.length);
    const wethUsdc = plan.filter((p) => lc(p.from) === lc(COVERAGE_WETH) && lc(p.to) === lc(COVERAGE_USDC));
    expect(wethUsdc).toHaveLength(1);
  });

  it("probes every non-quote token against both quote assets", () => {
    for (const t of tokens) {
      if (lc(t.address) === lc(COVERAGE_USDC) || lc(t.address) === lc(COVERAGE_WETH)) continue;
      const involving = plan.filter((p) => lc(p.subject) === lc(t.address) && p.direction !== "TOKEN_PAIR");
      expect(involving.length, `${t.symbol} was not probed in both directions against both quote assets`).toBe(4);
    }
  });

  it("includes arbitrary token/token pairs where neither side is a quote asset", () => {
    const tokenPairs = plan.filter((p) => p.direction === "TOKEN_PAIR");
    expect(tokenPairs).toHaveLength(12);
    for (const p of tokenPairs) {
      expect([lc(COVERAGE_USDC), lc(COVERAGE_WETH)]).not.toContain(lc(p.from));
      expect([lc(COVERAGE_USDC), lc(COVERAGE_WETH)]).not.toContain(lc(p.to));
      expect(lc(p.from)).not.toBe(lc(p.to));
    }
  });

  it("honours the token/token budget, including zero", () => {
    expect(coveragePairPlan(tokens, 0).filter((p) => p.direction === "TOKEN_PAIR")).toHaveLength(0);
    expect(coveragePairPlan(tokens, 3).filter((p) => p.direction === "TOKEN_PAIR")).toHaveLength(3);
  });

  it("never drops MPGR when the token/token sample is cut", () => {
    const small = coveragePairPlan(tokens, 0);
    expect(small.some((p) => lc(p.subject) === lc(COVERAGE_MPGR))).toBe(true);
  });
});

describe("coverageShard", () => {
  for (const shards of [1, 2, 3, 4, 7]) {
    it(`${shards} shard(s) partition the plan exactly once`, () => {
      const union: number[] = [];
      for (let shard = 1; shard <= shards; shard++) union.push(...coverageShard(plan, shard, shards).map((p) => p.index));
      expect(union.length).toBe(plan.length);
      expect(new Set(union).size).toBe(plan.length);
      expect([...union].sort((a, b) => a - b)).toEqual(plan.map((p) => p.index));
    });
  }

  it("keeps every subject in exactly one shard, so its discovery cost is paid once", () => {
    const shards = 4;
    const ownerOf = new Map<string, number>();
    for (let shard = 1; shard <= shards; shard++) {
      const slice = coverageShard(plan, shard, shards);
      expect(slice.every((p, i) => i === 0 || slice[i - 1].index < p.index)).toBe(true); // plan order preserved
      for (const pair of slice) {
        const key = lc(pair.subject);
        const seen = ownerOf.get(key);
        expect(seen === undefined || seen === shard).toBe(true);
        ownerOf.set(key, shard);
      }
    }
    expect(ownerOf.size).toBe(new Set(plan.map((p) => lc(p.subject))).size);
  });

  it("deals subjects evenly, so no shard is idle and none is swamped", () => {
    const shards = 4;
    const counts = [1, 2, 3, 4].map((shard) => new Set(coverageShard(plan, shard, shards).map((p) => lc(p.subject))).size);
    expect(counts.every((count) => count > 0)).toBe(true);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("gives one shard all of MPGR's probes, in both directions", () => {
    const shards = 4;
    const owners = new Map<number, string[]>();
    for (let shard = 1; shard <= shards; shard++) {
      const mpgr = coverageShard(plan, shard, shards).filter((p) => lc(p.subject) === lc(COVERAGE_MPGR) && p.direction !== "TOKEN_PAIR");
      if (mpgr.length > 0) owners.set(shard, mpgr.map((p) => p.direction));
    }
    // Grouping by subject deliberately concentrates a token's evidence in one shard;
    // the aggregate job is what makes losing that shard visible instead of silent.
    expect(owners.size).toBe(1);
    expect([...owners.values()].flat().sort()).toEqual(["BUY", "BUY", "SELL", "SELL"]);
  });

  it("rejects out-of-range shard arguments instead of returning an empty slice", () => {
    expect(() => coverageShard(plan, 0, 4)).toThrow(/outside 1\.\.4/);
    expect(() => coverageShard(plan, 5, 4)).toThrow(/outside 1\.\.4/);
    expect(() => coverageShard(plan, 1, 0)).toThrow(/positive integer/);
    expect(() => coverageShard(plan, 1.5, 4)).toThrow(/outside 1\.\.4/);
  });
});
