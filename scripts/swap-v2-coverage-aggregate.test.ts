// scripts/swap-v2-coverage-aggregate.test.ts
// Merges the sharded live coverage matrix into ONE report — offline.
//
// The merge itself is a pure function (lib/swap/v2/coverage-merge.ts) with its own
// offline unit tests. This file is the IO wrapper that CI runs: read the shard
// artifacts a real run produced, merge them against the deterministic plan, write
// the report, and fail when a planned pair was never attempted.
//
// NO RPC, NO SECRETS. Aggregation must stay offline, otherwise it would stop being
// an independent check on the shards.
//
// HONESTY RULES:
//  - No shard artifacts at all => SKIP with a loud warning. A skip is not a pass,
//    and "not measured" is never rendered as coverage.
//  - Fewer shards than expected => the merged matrix is still written and posted,
//    and this test FAILS: the acceptance criterion is that every planned pair was
//    attempted, and a quietly smaller matrix would look like a green run.
//  - Gaps are UNMEASURED, never missing liquidity.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyTokenSupport, renderCoverageMarkdown, summarizeUnmeasuredReasons,
  type PairCoverageRow,
} from "@/lib/swap/v2/coverage";
import { mergeCoverageShards, shardPartitionDefects, type CoverageShardArtifact } from "@/lib/swap/v2/coverage-merge";
// `planSize` is written by the shard so the aggregator can prove both jobs used the
// SAME plan; it is optional here only because an unsharded run may predate it.
type ShardWithPlanSize = CoverageShardArtifact & { planSize?: number };
import {
  COVERAGE_MPGR, COVERAGE_USDC, COVERAGE_WETH, coveragePairId, coveragePairPlan, coverageProbeTokens,
} from "@/lib/swap/v2/coverage-plan";
import { SWAP_V2_ENABLED_KINDS, SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/deployment";

const OUT_DIR = process.env.MPGR_V2_COVERAGE_DIR ?? "deployments/.local";
const REPORT_DIR = "deployments/.local";
const ENABLED = process.env.MPGR_V2_COVERAGE_AGGREGATE === "1" || process.env.MPGR_V2_COVERAGE_AGGREGATE === "true";
const MAX_TOKEN_TOKEN_PAIRS = Number(process.env.MPGR_V2_COVERAGE_MAX_PAIRS ?? 12);
const MAX_TOTAL_PAIRS = Number(process.env.MPGR_V2_COVERAGE_TOTAL_PAIRS ?? 250);
const EXPECTED_SHARDS = Math.max(1, Number(process.env.MPGR_V2_COVERAGE_SHARDS ?? 1));

function readShards(): ShardWithPlanSize[] {
  if (!existsSync(OUT_DIR)) return [];
  const names = readdirSync(OUT_DIR)
    // A shard artifact, or the single file an unsharded run writes. Per-shard
    // `*.shard-N-of-M.*` names are deliberately not matched: they are the same data.
    .filter((n) => /^swap-v2-coverage-(shard-\d+|matrix)\.json$/.test(n))
    .sort();
  const shards: ShardWithPlanSize[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(`${OUT_DIR}/${name}`, "utf8")) as ShardWithPlanSize & { rows?: PairCoverageRow[] };
      if (parsed && Array.isArray(parsed.rows)) shards.push(parsed);
      else console.warn(`::warning::${name} is not a coverage shard artifact; ignored`);
    } catch (error) {
      console.warn(`::warning::${name} could not be parsed (${error instanceof Error ? error.message : String(error)}); ignored`);
    }
  }
  return shards;
}

describe("V2 coverage matrix aggregation", () => {
  it("merges every shard and refuses to report a pair no shard attempted", async (ctx) => {
    if (!ENABLED) {
      console.warn("::notice::Coverage aggregation skipped — set MPGR_V2_COVERAGE_AGGREGATE=1 after the shards have run.");
      return ctx.skip();
    }
    const artifacts = readShards();
    if (artifacts.length === 0) {
      // A SKIP, not a pass: nothing was measured anywhere, so there is no matrix.
      console.warn(`::warning::NO coverage shard reported from ${OUT_DIR}. Coverage was NOT measured — this is not evidence of missing liquidity or of universal support.`);
      return ctx.skip();
    }

    const tokens = coverageProbeTokens();
    const plan = coveragePairPlan(tokens, MAX_TOKEN_TOKEN_PAIRS).slice(0, MAX_TOTAL_PAIRS);
    const expectedShards = Math.max(EXPECTED_SHARDS, ...artifacts.map((s) => s.shards || 1));

    // The aggregator rebuilds the plan offline. If the shards ran with a different
    // plan (different env in the two jobs), say THAT instead of reporting every pair
    // as unattempted — a confusing failure hides the real one.
    const recordedPlanSizes = [...new Set(artifacts.map((s) => s.planSize).filter((n) => typeof n === "number"))];
    expect(
      recordedPlanSizes,
      `shards disagreed about the plan size (${recordedPlanSizes.join(", ")}); the aggregator rebuilt ${plan.length} pairs`,
    ).toEqual([plan.length]);

    // The sharding function is part of what must be proven, against the PLAN.
    const partition = shardPartitionDefects(plan, expectedShards);
    expect(partition.duplicated, "a pair owned by two shards would be measured twice").toEqual([]);
    expect(partition.missing, "a pair owned by no shard would never be attempted").toEqual([]);

    const merged = mergeCoverageShards(artifacts, plan, expectedShards);
    const { rows, summary } = merged;

    const markdown = renderCoverageMarkdown(rows, {
      chainId: 8453, blockNumber: merged.blockLabel, rpcLabel: merged.rpcLabel,
      shards: { reported: merged.reportedShards.length, expected: expectedShards }, planSize: plan.length,
    });

    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(`${REPORT_DIR}/swap-v2-coverage-matrix.json`, JSON.stringify({
      chainId: 8453, blockNumber: merged.blockLabel, rpcLabel: merged.rpcLabel, summary, rows,
      shards: { reported: merged.reportedShards.length, expected: expectedShards, reportedShardIds: merged.reportedShards, perShard: merged.measuredByShard },
      planSize: plan.length,
      unreportedPairs: merged.unreported.map((p) => ({ index: p.index, from: p.from, to: p.to, fromSymbol: p.fromSymbol, toSymbol: p.toSymbol, direction: p.direction })),
      tokenFacts: merged.tokenFacts,
    }, null, 2));
    writeFileSync(`${REPORT_DIR}/swap-v2-coverage-matrix.md`, markdown);

    const isQuote = (a: string): boolean => a.toLowerCase() === COVERAGE_WETH.toLowerCase() || a.toLowerCase() === COVERAGE_USDC.toLowerCase();
    const mpgr = rows.filter((r) => r.from.toLowerCase() === COVERAGE_MPGR.toLowerCase() || r.to.toLowerCase() === COVERAGE_MPGR.toLowerCase());
    const quotePairs = rows.filter((r) => isQuote(r.from) || isQuote(r.to));
    console.log(`::notice::MERGED V2 coverage from ${merged.reportedShards.length}/${expectedShards} shards at block ${merged.blockLabel}: ${summary.executable} executable, ${summary.missingLiquidity} missing liquidity, ${summary.unsupportedToken} unsupported token, ${summary.unmeasured} unmeasured of ${summary.pairs} planned pairs`);
    console.log(`::notice::per shard: ${merged.measuredByShard.map((s) => `#${s.shard} ${s.executable} executable / ${s.measured} measured / ${s.unmeasured} unmeasured${s.budgetExhausted ? " (BUDGET EXHAUSTED)" : ""}`).join(" | ")}`);
    console.log(`::notice::MPGR pairs: ${mpgr.map((r) => `${r.direction} ${r.fromSymbol}->${r.toSymbol} ${r.category}`).join(" | ") || "none planned"}`);
    console.log(`::notice::Pairs involving a quote asset (WETH/USDC): ${quotePairs.length}, executable ${quotePairs.filter((r) => r.category === "EXECUTABLE_ROUTE").length}`);
    for (const u of summarizeUnmeasuredReasons(rows)) console.log(`::notice::unmeasured[${u.count}]: ${u.reason}`);
    if (merged.unreported.length > 0) {
      console.warn(`::warning::${merged.unreported.length} planned pair(s) were reported by NO shard: indices ${merged.unreported.slice(0, 20).map((p) => p.index).join(", ")}${merged.unreported.length > 20 ? ", ..." : ""}`);
    }

    // --- Assertions on the MERGED matrix. ---
    expect(summary.pairs, "the merged matrix must contain exactly one row per planned pair").toBe(plan.length);
    expect(rows.length).toBe(plan.length);
    expect(new Set(rows.map((r) => coveragePairId(r.from, r.to))).size, "no duplicate pair in the merged matrix").toBe(plan.length);
    // A shard that did not report is a failed run, not a smaller success.
    expect(merged.reportedShards.length, `expected ${expectedShards} shards to report; got ${merged.reportedShards.join(", ") || "none"}`).toBe(expectedShards);
    expect(merged.duplicated, "no pair may be owned by two shards").toEqual([]);
    expect(merged.unreported.length, "every planned pair must have been attempted by some shard").toBe(0);
    // Defects fail the run; coverage gaps are reported, not hidden.
    expect(summary.feeDefects, rows.filter((r) => r.category === "FEE_INVARIANT_DEFECT").map((r) => r.reason).join("; ")).toBe(0);
    for (const row of rows.filter((r) => r.category === "EXECUTABLE_ROUTE")) {
      expect(row.hops!).toBeGreaterThanOrEqual(1);
      expect(row.hops!).toBeLessThanOrEqual(3);
      expect(row.legs!).toBeGreaterThanOrEqual(1);
      expect(row.legs!).toBeLessThanOrEqual(4);
      for (const kind of row.venueKinds!) expect(SWAP_V2_ENABLED_KINDS as readonly number[]).toContain(kind);
    }
    for (const row of rows.filter((r) => !r.measured)) expect(row.category).toBe("UNMEASURED_PROVIDER_FAILURE");
    // A liquidity verdict requires a measurement; a discovery outage does not.
    expect(rows.filter((r) => r.category === "MISSING_LIQUIDITY").every((r) => r.measured)).toBe(true);
    // Token facts must agree with the pair verdicts across the whole matrix.
    for (const fact of merged.tokenFacts) {
      const classified = classifyTokenSupport(fact);
      if (!classified.supported && classified.category === "UNSUPPORTED_TOKEN_INFRASTRUCTURE") {
        const involving = rows.filter((r) => r.from.toLowerCase() === fact.address.toLowerCase() || r.to.toLowerCase() === fact.address.toLowerCase());
        expect(involving.every((r) => r.category !== "EXECUTABLE_ROUTE"), `${fact.address} routed despite unsupported infrastructure`).toBe(true);
      }
    }
    expect(SWAP_V2_SEALED_MANIFEST.chainId).toBe(8453);
  });
});
