// lib/swap/v2/coverage-merge.ts
// Merging the sharded live coverage matrix, as a pure function.
//
// WHY THIS IS NOT INSIDE THE AGGREGATOR SCRIPT. Sharding multiplies the
// measurement budget but creates a new way for a coverage report to lie: a shard
// that timed out, crashed or was never scheduled silently shrinks the matrix, and
// a smaller matrix with the same green checkmark looks like better coverage. The
// guard against that has to be testable OFFLINE, without Base and without any
// shard artifact from a real run — otherwise the only way to check it is to break a
// CI job on purpose.
//
// So the merge is pure: give it shard artifacts and the deterministic plan, and it
// returns one row per planned pair. Any pair no shard reported becomes an explicit
// UNMEASURED row and is listed in `unreported`. A gap is never dropped, never
// re-categorised, and never counted as missing liquidity.
import "server-only";
import {
  summarizeCoverage, type CoverageSummary, type PairCoverageRow, type TokenSupportFacts,
} from "./coverage";
import { coveragePairId, coverageShard, type CoveragePair } from "./coverage-plan";

export interface CoverageShardArtifact {
  shard: number;
  shards: number;
  blockNumber: string;
  rpcLabel: string;
  rows: readonly PairCoverageRow[];
  tokenFacts?: readonly TokenSupportFacts[];
  ownedIndices?: readonly number[];
  elapsedMs?: number | null;
  budgetExhaustedAt?: number | null;
  v4RpcCalls?: { getCode: number; getLogs: number } | null;
}

export interface MergedCoverage {
  /** Exactly one row per planned pair, in plan order. */
  rows: PairCoverageRow[];
  /** Planned pairs that NO shard reported. These are the honest gaps. */
  unreported: CoveragePair[];
  /** Planned pairs reported by more than one shard — a sharding defect. */
  duplicated: number[];
  tokenFacts: TokenSupportFacts[];
  blockLabel: string;
  blockNumbers: readonly string[];
  rpcLabel: string;
  summary: CoverageSummary;
  reportedShards: readonly number[];
  expectedShards: number;
  planSize: number;
  measuredByShard: { shard: number; measured: number; executable: number; unmeasured: number; budgetExhausted: boolean }[];
}

/**
 * Proves the sharding function partitions the plan: disjoint, and complete. Both
 * properties are checked against the PLAN, not against what shards claim.
 *
 * Ownership is derived by calling `coverageShard` — the function the shards themselves
 * run. It used to be an inline round-robin loop here, which made the whole check
 * vacuous: it validated its own loop, so it reported a perfect partition no matter how
 * pairs were actually assigned. That went unnoticed until sharding became
 * SUBJECT-GROUPED (a token's pairs all land in one shard, because the expensive work is
 * per token), at which point round-robin and reality disagreed on essentially every
 * pair while this function still returned `{ duplicated: [], missing: [] }`. A green
 * check that cannot fail is worse than no check, because it is read as a proof.
 *
 * `ownerOf` is returned so a test can assert agreement with `coverageShard` pair by
 * pair, which is the falsifiable form of the same claim.
 */
export function shardPartitionDefects(
  plan: readonly CoveragePair[], shards: number,
): { duplicated: number[]; missing: number[]; ownerOf: Map<number, number> } {
  const ownerOf = new Map<number, number>();
  const duplicated: number[] = [];
  for (let shard = 1; shard <= shards; shard++) {
    for (const pair of coverageShard(plan, shard, shards)) {
      if (ownerOf.has(pair.index)) duplicated.push(pair.index);
      ownerOf.set(pair.index, shard);
    }
  }
  const missing = plan.filter((p) => !ownerOf.has(p.index)).map((p) => p.index);
  return { duplicated, missing, ownerOf };
}

export function mergeCoverageShards(
  artifacts: readonly CoverageShardArtifact[],
  plan: readonly CoveragePair[],
  expectedShards: number,
): MergedCoverage {
  // One artifact per shard id. If a shard somehow produced two, keep the one that
  // measured more rather than silently picking the first.
  const byShard = new Map<number, CoverageShardArtifact>();
  for (const artifact of artifacts) {
    const previous = byShard.get(artifact.shard);
    if (!previous || artifact.rows.filter((r) => r.measured).length > previous.rows.filter((r) => r.measured).length) {
      byShard.set(artifact.shard, artifact);
    }
  }
  const shards = [...byShard.values()].sort((a, b) => a.shard - b.shard);

  const byId = new Map<string, PairCoverageRow>();
  const duplicated = new Set<number>();
  const reportedIndices = new Set<number>();
  for (const shard of shards) {
    for (const row of shard.rows) {
      const id = coveragePairId(row.from, row.to);
      const previous = byId.get(id);
      if (previous) {
        if (typeof row.index === "number" && reportedIndices.has(row.index)) duplicated.add(row.index);
        // Never overwrite a measurement with a gap.
        if (!previous.measured && row.measured) byId.set(id, { ...row, shard: shard.shard });
        continue;
      }
      byId.set(id, { ...row, shard: shard.shard });
      if (typeof row.index === "number") reportedIndices.add(row.index);
    }
  }

  const rows: PairCoverageRow[] = [];
  const unreported: CoveragePair[] = [];
  for (const pair of plan) {
    const row = byId.get(coveragePairId(pair.from, pair.to));
    if (row) {
      // The PLAN owns the pair's identity — index, subject, direction and the
      // symbols it is reported under — so a shard that mislabelled any of them
      // cannot change what the merged report says this pair was. Only the verdict
      // and its evidence come from the shard.
      rows.push({
        ...row, index: pair.index, subjectSymbol: pair.subjectSymbol, direction: pair.direction,
        fromSymbol: pair.fromSymbol, toSymbol: pair.toSymbol,
      });
    } else {
      unreported.push(pair);
      rows.push({
        index: pair.index, from: pair.from, to: pair.to,
        fromSymbol: pair.fromSymbol, toSymbol: pair.toSymbol,
        subjectSymbol: pair.subjectSymbol, direction: pair.direction,
        category: "UNMEASURED_PROVIDER_FAILURE", measured: false,
        reason: `No shard reported this pair (expected ${expectedShards} shards, ${shards.length} reported: ${shards.map((s) => s.shard).join(", ") || "none"}). Not measured — not evidence of missing liquidity.`,
      });
    }
  }
  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const facts = new Map<string, TokenSupportFacts>();
  for (const shard of shards) for (const fact of shard.tokenFacts ?? []) facts.set(fact.address.toLowerCase(), fact);

  const blockNumbers = [...new Set(shards.map((s) => s.blockNumber))].filter(Boolean).sort((a, b) => Number(a) - Number(b));
  const blockLabel = blockNumbers.length === 0
    ? ""
    : blockNumbers.length === 1
      ? blockNumbers[0]
      : `${blockNumbers[0]}–${blockNumbers[blockNumbers.length - 1]} (shards pinned different blocks)`;

  return {
    rows,
    unreported,
    duplicated: [...duplicated].sort((a, b) => a - b),
    tokenFacts: [...facts.values()],
    blockLabel,
    blockNumbers,
    rpcLabel: [...new Set(shards.map((s) => s.rpcLabel))].filter(Boolean).join(", "),
    summary: summarizeCoverage(rows),
    reportedShards: shards.map((s) => s.shard),
    expectedShards,
    planSize: plan.length,
    measuredByShard: shards.map((s) => {
      const summary = summarizeCoverage(s.rows);
      return {
        shard: s.shard, measured: summary.measured, executable: summary.executable, unmeasured: summary.unmeasured,
        budgetExhausted: s.budgetExhaustedAt !== null && s.budgetExhaustedAt !== undefined,
      };
    }),
  };
}
