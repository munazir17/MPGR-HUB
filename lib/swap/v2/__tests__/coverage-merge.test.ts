// Offline tests for merging the sharded coverage matrix.
//
// These are the tests that stop sharding from becoming a way to shrink a coverage
// report: a missing shard must turn into explicit UNMEASURED rows and a listed gap,
// never into a smaller matrix that still looks green. No RPC, no artifacts from a
// real run — the fixtures here are fabricated on purpose so the failure modes can
// be exercised without breaking CI.
import { describe, expect, it } from "vitest";
import { coveragePairId, coveragePairPlan, coverageProbeTokens, coverageShard, type CoveragePair } from "../coverage-plan";
import { mergeCoverageShards, shardPartitionDefects, type CoverageShardArtifact } from "../coverage-merge";
import type { PairCoverageRow, TokenSupportFacts } from "../coverage";

const tokens = coverageProbeTokens();
const plan = coveragePairPlan(tokens, 6);
const SHARDS = 4;

const executableRow = (pair: CoveragePair, kinds: readonly number[] = [7]): PairCoverageRow => ({
  index: pair.index, from: pair.from, to: pair.to, fromSymbol: pair.fromSymbol, toSymbol: pair.toSymbol,
  category: "EXECUTABLE_ROUTE", measured: true, reason: "quoted", hops: 1, legs: 1, venueKinds: kinds, amountOut: "1000",
});
const unmeasuredRow = (pair: CoveragePair, reason = "discovery unavailable"): PairCoverageRow => ({
  index: pair.index, from: pair.from, to: pair.to, category: "UNMEASURED_PROVIDER_FAILURE", measured: false, reason,
});

/** Builds the artifact one honest shard would have written for its slice. */
function artifact(shard: number, make: (pair: CoveragePair) => PairCoverageRow = executableRow, over: Partial<CoverageShardArtifact> = {}): CoverageShardArtifact {
  const slice = coverageShard(plan, shard, SHARDS);
  return {
    shard, shards: SHARDS, blockNumber: "52856963", rpcLabel: "[RPC]",
    rows: slice.map(make), ownedIndices: slice.map((p) => p.index), tokenFacts: [],
    ...over,
  };
}
const allShards = (): CoverageShardArtifact[] => Array.from({ length: SHARDS }, (_unused, i) => artifact(i + 1));

describe("shardPartitionDefects", () => {
  it("reports no defect for the real plan", () => {
    expect(shardPartitionDefects(plan, SHARDS)).toMatchObject({ duplicated: [], missing: [] });
  });

  it("derives ownership from coverageShard itself, pair by pair", () => {
    // THE FALSIFIABLE FORM. The old implementation re-derived ownership with an inline
    // round-robin loop, so it agreed with itself and could never fail; this asserts
    // agreement with the function the shards actually run. Subject-grouped sharding
    // assigns a token's pairs to ONE shard, which round-robin does not, so this test
    // fails loudly if the check ever stops calling coverageShard again.
    for (const shards of [1, 2, 3, 4, 6, 7]) {
      const { ownerOf, duplicated, missing } = shardPartitionDefects(plan, shards);
      expect(duplicated, `shards=${shards}`).toEqual([]);
      expect(missing, `shards=${shards}`).toEqual([]);
      expect(ownerOf.size).toBe(plan.length);
      for (let shard = 1; shard <= shards; shard++) {
        for (const pair of coverageShard(plan, shard, shards)) {
          expect(ownerOf.get(pair.index), `pair ${pair.index} at shards=${shards}`).toBe(shard);
        }
      }
    }
  });

  it("is not round-robin, because round-robin is what made the old check vacuous", () => {
    const { ownerOf } = shardPartitionDefects(plan, SHARDS);
    const roundRobin = new Map<number, number>();
    for (let shard = 1; shard <= SHARDS; shard++) {
      for (let i = shard - 1; i < plan.length; i += SHARDS) roundRobin.set(plan[i].index, shard);
    }
    // If these agreed, the regression above would be untestable: the two assignments
    // must actually differ for the fix to mean anything.
    const disagreements = plan.filter((p) => ownerOf.get(p.index) !== roundRobin.get(p.index));
    expect(disagreements.length).toBeGreaterThan(0);
    // And the difference is exactly the point: every pair about one token lands in one
    // shard, so a shard pays that token's discovery cost once instead of per pair.
    const bySubject = new Map<string, Set<number>>();
    for (const pair of plan) {
      const owners = bySubject.get(pair.subject.toLowerCase()) ?? new Set<number>();
      owners.add(ownerOf.get(pair.index)!);
      bySubject.set(pair.subject.toLowerCase(), owners);
    }
    for (const owners of bySubject.values()) expect(owners.size).toBe(1);
  });

  it("reports a pair no shard would attempt when a shard is dropped from the count", () => {
    // Partitioning into 4 but only running 3 leaves a quarter of the plan unowned.
    const seen = new Set<number>();
    for (let shard = 1; shard <= 3; shard++) for (const p of coverageShard(plan, shard, SHARDS)) seen.add(p.index);
    expect(plan.filter((p) => !seen.has(p.index)).length).toBeGreaterThan(0);
  });
});

describe("mergeCoverageShards", () => {
  it("reproduces the plan exactly, in plan order, when every shard reports", () => {
    const merged = mergeCoverageShards(allShards(), plan, SHARDS);
    expect(merged.rows).toHaveLength(plan.length);
    expect(merged.summary.pairs).toBe(plan.length);
    expect(merged.summary.executable).toBe(plan.length);
    expect(merged.summary.unmeasured).toBe(0);
    expect(merged.unreported).toEqual([]);
    expect(merged.duplicated).toEqual([]);
    expect(merged.reportedShards).toEqual([1, 2, 3, 4]);
    expect(merged.rows.map((r) => r.index)).toEqual(plan.map((p) => p.index));
    expect(new Set(merged.rows.map((r) => coveragePairId(r.from, r.to))).size).toBe(plan.length);
  });

  it("turns a missing shard into explicit UNMEASURED rows and a listed gap", () => {
    const merged = mergeCoverageShards([artifact(1), artifact(2), artifact(4)], plan, SHARDS);
    const missing = coverageShard(plan, 3, SHARDS);
    expect(merged.rows).toHaveLength(plan.length);
    expect(merged.unreported.map((p) => p.index)).toEqual(missing.map((p) => p.index));
    expect(merged.summary.unmeasured).toBe(missing.length);
    expect(merged.summary.executable).toBe(plan.length - missing.length);
    for (const pair of missing) {
      const row = merged.rows[pair.index];
      expect(row.category).toBe("UNMEASURED_PROVIDER_FAILURE");
      expect(row.measured).toBe(false);
      expect(row.reason).toMatch(/No shard reported this pair/);
      expect(row.reason).toMatch(/expected 4 shards, 3 reported/);
      // The gap keeps its plan identity, so the by-token/direction rollups still
      // attribute it to the right asset instead of dropping it.
      expect(row.subjectSymbol).toBe(pair.subjectSymbol);
      expect(row.direction).toBe(pair.direction);
    }
  });

  it("never lets a gap overwrite a measurement when shards overlap", () => {
    const overlap = plan[0];
    const honest = artifact(1);
    const duplicateWithGap = artifact(2, unmeasuredRow, {
      rows: [unmeasuredRow(overlap)], ownedIndices: [overlap.index],
    });
    const merged = mergeCoverageShards([duplicateWithGap, honest], plan, SHARDS);
    const row = merged.rows[overlap.index];
    expect(row.category).toBe("EXECUTABLE_ROUTE");
    expect(row.measured).toBe(true);
    expect(merged.duplicated).toContain(overlap.index);
  });

  it("prefers the measured row regardless of artifact order", () => {
    const overlap = plan[1];
    const gapFirst = artifact(1, unmeasuredRow, { rows: [unmeasuredRow(overlap)], ownedIndices: [overlap.index] });
    const measuredSecond = artifact(2, executableRow, { rows: [executableRow(overlap)], ownedIndices: [overlap.index] });
    expect(mergeCoverageShards([gapFirst, measuredSecond], plan, SHARDS).rows[overlap.index].measured).toBe(true);
    expect(mergeCoverageShards([measuredSecond, gapFirst], plan, SHARDS).rows[overlap.index].measured).toBe(true);
  });

  it("keeps one artifact per shard id, choosing the one that measured more", () => {
    const weak = artifact(1, unmeasuredRow);
    const strong = artifact(1, executableRow);
    const merged = mergeCoverageShards([weak, strong, artifact(2), artifact(3), artifact(4)], plan, SHARDS);
    expect(merged.reportedShards).toEqual([1, 2, 3, 4]);
    expect(merged.summary.executable).toBe(plan.length);
  });

  it("lets the PLAN own index, subject and direction, not the shard", () => {
    const pair = plan[2];
    const lying: CoverageShardArtifact = {
      shard: 1, shards: SHARDS, blockNumber: "1", rpcLabel: "[RPC]", ownedIndices: [pair.index],
      rows: [{
        ...executableRow(pair), index: 999, subjectSymbol: "WRONG", direction: "TOKEN_PAIR",
        fromSymbol: "WRONG", toSymbol: "WRONG",
      }],
    };
    const merged = mergeCoverageShards([lying, artifact(2), artifact(3), artifact(4)], plan, SHARDS);
    const row = merged.rows[pair.index];
    expect(row.index).toBe(pair.index);
    expect(row.subjectSymbol).toBe(pair.subjectSymbol);
    expect(row.direction).toBe(pair.direction);
    expect(row.fromSymbol).toBe(pair.fromSymbol);
    expect(row.toSymbol).toBe(pair.toSymbol);
  });

  it("merges token facts once per address", () => {
    const fact = (address: string, over: Partial<TokenSupportFacts> = {}): TokenSupportFacts =>
      ({ address, hasCode: true, decimals: 18, symbol: "TK", readable: true, ...over });
    const a = plan[0].from;
    const merged = mergeCoverageShards(
      [artifact(1, executableRow, { tokenFacts: [fact(a), fact(plan[0].to)] }), artifact(2, executableRow, { tokenFacts: [fact(a, { decimals: 6 })] })],
      plan, SHARDS,
    );
    const forA = merged.tokenFacts.filter((f) => f.address.toLowerCase() === a.toLowerCase());
    expect(forA).toHaveLength(1);
    expect(forA[0].decimals).toBe(6); // the later shard's read wins, deterministically
  });

  it("says when shards pinned different blocks instead of pretending they agree", () => {
    const merged = mergeCoverageShards([
      artifact(1, executableRow, { blockNumber: "52856963" }),
      artifact(2, executableRow, { blockNumber: "52856990" }),
      artifact(3, executableRow, { blockNumber: "52856963" }),
      artifact(4, executableRow, { blockNumber: "52857001" }),
    ], plan, SHARDS);
    expect(merged.blockNumbers).toEqual(["52856963", "52856990", "52857001"]);
    expect(merged.blockLabel).toMatch(/52856963–52857001/);
    expect(merged.blockLabel).toMatch(/different blocks/);
  });

  it("reports one block plainly when every shard agrees", () => {
    expect(mergeCoverageShards(allShards(), plan, SHARDS).blockLabel).toBe("52856963");
  });

  it("records per-shard measurement counts and whether a shard ran out of budget", () => {
    const merged = mergeCoverageShards([
      artifact(1, executableRow, { elapsedMs: 1000, budgetExhaustedAt: null }),
      artifact(2, unmeasuredRow, { elapsedMs: 1_260_000, budgetExhaustedAt: 7 }),
      artifact(3), artifact(4),
    ], plan, SHARDS);
    expect(merged.measuredByShard[0]).toMatchObject({ shard: 1, budgetExhausted: false });
    expect(merged.measuredByShard[1]).toMatchObject({ shard: 2, budgetExhausted: true, executable: 0 });
    expect(merged.measuredByShard[1].measured).toBe(0);
  });

  it("handles an empty shard list without inventing coverage", () => {
    const merged = mergeCoverageShards([], plan, SHARDS);
    expect(merged.rows).toHaveLength(plan.length);
    expect(merged.summary.measured).toBe(0);
    expect(merged.summary.executable).toBe(0);
    expect(merged.unreported).toHaveLength(plan.length);
    expect(merged.reportedShards).toEqual([]);
    expect(merged.blockLabel).toBe("");
  });

  it("reports an unexpected extra shard count from the artifacts themselves", () => {
    // If the workflow's shard count and the artifacts disagree, the merge must not
    // silently accept the smaller number.
    const merged = mergeCoverageShards([artifact(1), artifact(2)], plan, SHARDS);
    expect(merged.expectedShards).toBe(SHARDS);
    expect(merged.reportedShards).toEqual([1, 2]);
    expect(merged.unreported.length).toBeGreaterThan(0);
  });
});
