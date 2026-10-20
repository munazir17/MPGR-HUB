// Live V2 coverage matrix — one SHARD of it.
//
// Runs the app's REAL discovery stack (`RpcV2LiquiditySource` + `discoverV2Quote`)
// against Base and classifies every probed pair. This is the evidence behind any
// claim about which tokens are actually tradeable.
//
// WHY IT IS SHARDED. A single run had one global wall-clock budget for the whole
// plan, so most pairs were never even attempted: run 39431366188 measured 54 of
// 212 and recorded 158 UNMEASURED, ~110 of them purely "probe budget exhausted".
// That is not a coverage fact, it is a scheduling artefact. The plan is pure and
// deterministic (lib/swap/v2/coverage-plan.ts), so `index % shards` splits it into
// disjoint bounded batches, each with its OWN budget, and
// scripts/swap-v2-coverage-aggregate.test.ts merges the shards back and proves no
// pair was dropped.
//
// HONESTY RULES, enforced here:
//  - No RPC reachability => the test SKIPS and prints why. A skip is never a pass,
//    and an unmeasured matrix is never presented as coverage.
//  - A discovery outage on a pair is recorded UNMEASURED, not missing liquidity.
//  - A fee-invariant defect fails the run: that is a bug, not a coverage fact.
//  - Nothing is broadcast. Discovery is read-only.
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { discoverV2Quote, V2QuoteError } from "@/lib/swap/v2/discovery";
import { RpcV2LiquiditySource } from "@/lib/swap/v2/rpc-source";
import { V4DiscoveryCache } from "@/lib/swap/v2/rpc-v4";
import { SWAP_V2_ENABLED_KINDS, SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/deployment";
import {
  classifyPairOutcome, classifyTokenSupport, renderCoverageMarkdown, summarizeCoverage,
  summarizeUnmeasuredReasons, type PairCoverageRow, type TokenSupportFacts,
} from "@/lib/swap/v2/coverage";
import {
  COVERAGE_MPGR, coveragePairPlan, coverageProbeTokens, coverageShard,
  type CoveragePair, type CoverageToken,
} from "@/lib/swap/v2/coverage-plan";
import { erc20Abi } from "@/lib/erc20-abi";

const RPC_URL = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
// OPT-IN. This filename matches vitest's test-file glob, so without a gate the
// ordinary `npm test` run would attempt the full live matrix — which is exactly
// what cancelled CI's quality job on the first attempt. The dedicated coverage
// workflow sets MPGR_V2_COVERAGE=1; everywhere else this skips immediately.
const ENABLED = process.env.MPGR_V2_COVERAGE === "1" || process.env.MPGR_V2_COVERAGE === "true";
/** Wall-clock budget per pair, so one slow pair cannot consume the whole shard. A
 * timeout is recorded as UNMEASURED — never as missing liquidity. */
const PER_PAIR_TIMEOUT_MS = Number(process.env.MPGR_V2_COVERAGE_PAIR_TIMEOUT_MS ?? 60_000);
const OUT_DIR = "deployments/.local";
/** Bound the arbitrary token/token sample so the run stays inside CI time limits.
 * This is a SAMPLE; it is never presented as the whole Base token universe. */
const MAX_TOKEN_TOKEN_PAIRS = Number(process.env.MPGR_V2_COVERAGE_MAX_PAIRS ?? 12);
/** Hard cap on the PLAN, applied before sharding so every shard sees an identical
 * plan and the aggregator can prove nothing was dropped. */
const MAX_TOTAL_PAIRS = Number(process.env.MPGR_V2_COVERAGE_TOTAL_PAIRS ?? 250);
/** 1-based shard index and shard count. Shards are disjoint and their union is the
 * whole (capped) plan. */
const SHARDS = Math.max(1, Number(process.env.MPGR_V2_COVERAGE_SHARDS ?? 1));
const SHARD = Math.min(SHARDS, Math.max(1, Number(process.env.MPGR_V2_COVERAGE_SHARD ?? 1)));
/** Per-SHARD wall-clock budget, so sharding actually multiplies the available
 * measurement time instead of splitting one fixed amount. Kept well below the
 * vitest timeout below, so the shard's matrix is always written before any timeout
 * could discard it. */
const SHARD_BUDGET_MS = Number(process.env.MPGR_V2_COVERAGE_BUDGET_MS ?? 1_260_000);
/** Cap on eth_getLogs calls per token's v4 Initialize search. Bounded on purpose:
 * an unbounded scan is how the previous run timed out before measuring anything. */
const V4_MAX_LOG_CALLS = Number(process.env.MPGR_V2_COVERAGE_V4_LOG_CALLS ?? 64);
const PROBE_AMOUNT = 1_000_000n;

function buildClient() {
  return createPublicClient({
    chain: base,
    // Retries matter here: several shards hit the same provider concurrently, and a
    // 429 must be absorbed rather than recorded as an unmeasured pair.
    transport: http(RPC_URL, { timeout: 30_000, retryCount: 5, retryDelay: 1_000 }),
  });
}
type Client = ReturnType<typeof buildClient>;

async function reachable(): Promise<{ ok: true; client: Client } | { ok: false; reason: string }> {
  try {
    const client = buildClient();
    const chainId = await Promise.race([
      client.getChainId(),
      new Promise<never>((_res, rej) => setTimeout(() => rej(new Error("timeout")), 20_000)),
    ]);
    if (chainId !== 8453) return { ok: false, reason: `RPC reported chain ${chainId}, not Base 8453` };
    return { ok: true, client };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Reads the on-chain facts that separate "unsupported token" from "no liquidity". */
async function tokenFacts(client: Client, address: Address, blockNumber: bigint): Promise<TokenSupportFacts> {
  try {
    const [code, decimals, symbol] = await Promise.all([
      client.getCode({ address, blockNumber }),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }).catch(() => null),
      client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber }).catch(() => null),
    ]);
    return {
      address, hasCode: !!code && code !== "0x",
      decimals: typeof decimals === "number" ? decimals : null,
      symbol: typeof symbol === "string" ? symbol : null,
      readable: true,
    };
  } catch {
    return { address, hasCode: false, decimals: null, symbol: null, readable: false };
  }
}

/** The full deterministic plan, then this shard's disjoint slice of it. */
function planFor(tokens: readonly CoverageToken[]): { plan: CoveragePair[]; shard: CoveragePair[] } {
  const plan = coveragePairPlan(tokens, MAX_TOKEN_TOKEN_PAIRS).slice(0, MAX_TOTAL_PAIRS);
  return { plan, shard: coverageShard(plan, SHARD, SHARDS) };
}

describe("V2 live coverage matrix", () => {
  it(
    `shard ${SHARD}/${SHARDS}: classifies real Base pairs and refuses to claim unmeasured coverage`,
    async (ctx) => {
      if (!ENABLED) {
        console.warn("::notice::V2 coverage matrix skipped — set MPGR_V2_COVERAGE=1 to measure it. Not measured, not claimed.");
        return ctx.skip();
      }
      const probe = await reachable();
      if (!probe.ok) {
        // A SKIP, not a pass. Printed loudly so no report can mistake it for
        // measured coverage.
        console.warn(`::warning::V2 coverage matrix NOT MEASURED — Base RPC unreachable at [RPC]: ${probe.reason}`);
        return ctx.skip();
      }
      const { client } = probe;
      const block = await client.getBlock();
      if (block.number === null) return ctx.skip();
      const blockNumber = block.number;
      const tokens = coverageProbeTokens();
      const { plan, shard } = planFor(tokens);
      // Only the tokens this shard actually probes are read, so a shard never pays
      // for another shard's metadata.
      const touched = new Set<string>();
      for (const p of shard) { touched.add(p.from.toLowerCase()); touched.add(p.to.toLowerCase()); }
      const facts = new Map<string, TokenSupportFacts>();
      for (const t of tokens) {
        if (!touched.has(t.address.toLowerCase())) continue;
        facts.set(t.address.toLowerCase(), await tokenFacts(client, t.address, blockNumber));
      }

      // ONE cache for the whole shard: a token's deployment-block binary search and
      // its v4 `Initialize` scan are functions of (token, pinned block) alone, so
      // probing the same token against several counterparties must not repeat them.
      const v4Cache = new V4DiscoveryCache();
      const startedAt = Date.now();
      const rows: PairCoverageRow[] = [];
      let budgetExhaustedAt: number | null = null;
      for (const pair of shard) {
        const { from, to, index, subjectSymbol, direction } = pair;
        const meta = { index, shard: SHARD, subjectSymbol, direction };
        if (Date.now() - startedAt > SHARD_BUDGET_MS) {
          // Out of budget: record what is left as UNMEASURED and stop. Reporting
          // fewer pairs honestly beats timing out and reporting none.
          if (budgetExhaustedAt === null) budgetExhaustedAt = index;
          rows.push({
            ...meta, from, to, fromSymbol: pair.fromSymbol, toSymbol: pair.toSymbol,
            category: "UNMEASURED_PROVIDER_FAILURE", measured: false,
            reason: `Probe budget exhausted before this pair was measured (shard ${SHARD}/${SHARDS}, ${SHARD_BUDGET_MS}ms).`,
          });
          continue;
        }
        // maxSweepCalls: 0 — rely on the bounded factory index plus the bounded v4
        // search. The universal block-0 sweep cannot be served by a range-capped
        // provider and previously made most pairs time out before measurement.
        const source = new RpcV2LiquiditySource(
          client as never, blockNumber, 4096, 0,
          { cache: v4Cache, maxLogCalls: V4_MAX_LOG_CALLS },
        );
        let outcome: Parameters<typeof classifyPairOutcome>[2];
        try {
          const quote = await Promise.race([
            discoverV2Quote(source, from, to, PROBE_AMOUNT),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error(`discovery exceeded ${PER_PAIR_TIMEOUT_MS}ms`)), PER_PAIR_TIMEOUT_MS)),
          ]);
          outcome = { ok: true, quote };
        } catch (error) {
          // A timeout or transport failure is UNMEASURED by construction: the
          // classifier maps any non-V2QuoteError to UNMEASURED_PROVIDER_FAILURE.
          outcome = { ok: false, error };
        }
        const row = classifyPairOutcome(from, to, outcome, {
          from: facts.get(from.toLowerCase()), to: facts.get(to.toLowerCase()),
        });
        const fromSymbol = pair.fromSymbol;
        const toSymbol = pair.toSymbol;
        // A verdict is only as strong as the search behind it. Record what discovery
        // could actually establish for this pair, so a weak verdict is visible.
        const diag = source.diagnostics();
        const evidenceScope = [
          `sweep ${diag.historyScan}`,
          `factory index ${diag.factoryIndex ? (diag.factoryIndex.complete ? "complete" : `partial (failed kinds ${diag.factoryIndex.failedKinds.join("/") || "none"})`) : "did not run"}`,
          `v4 ${diag.v4 ? `${diag.v4.state}${diag.v4.state === "complete" ? "" : ` — ${diag.v4.note.slice(0, 160)}`}` : "did not run"}`,
        ].join("; ");
        rows.push({ ...meta, ...row, fromSymbol, toSymbol, evidenceScope });
      }

      const summary = summarizeCoverage(rows);
      const rpcLabel = process.env.BASE_MAINNET_RPC_URL ? "secrets.BASE_MAINNET_RPC_URL" : "https://mainnet.base.org (public)";
      const markdown = renderCoverageMarkdown(rows, {
        chainId: 8453, blockNumber: blockNumber.toString(), rpcLabel,
        shards: { reported: 1, expected: SHARDS }, planSize: plan.length,
      });

      mkdirSync(OUT_DIR, { recursive: true });
      const artifact = {
        chainId: 8453, blockNumber: blockNumber.toString(), rpcLabel, summary, rows,
        shard: SHARD, shards: SHARDS, planSize: plan.length,
        ownedIndices: shard.map((p) => p.index),
        budgetExhaustedAt,
        shardBudgetMs: SHARD_BUDGET_MS,
        perPairTimeoutMs: PER_PAIR_TIMEOUT_MS,
        v4MaxLogCalls: V4_MAX_LOG_CALLS,
        v4RpcCalls: { ...v4Cache.totals },
        elapsedMs: Date.now() - startedAt,
        tokenFacts: [...facts.values()],
      };
      // A shard must NOT write the unsharded names: those belong to the merged
      // matrix the aggregator produces, and overwriting them with one shard's slice
      // is exactly how a partial run would come to look like a complete one.
      const json = JSON.stringify(artifact, null, 2);
      if (SHARDS > 1) {
        writeFileSync(`${OUT_DIR}/swap-v2-coverage-shard-${SHARD}.json`, json);
        writeFileSync(`${OUT_DIR}/swap-v2-coverage-matrix.shard-${SHARD}-of-${SHARDS}.md`, markdown);
      } else {
        writeFileSync(`${OUT_DIR}/swap-v2-coverage-matrix.json`, json);
        writeFileSync(`${OUT_DIR}/swap-v2-coverage-matrix.md`, markdown);
      }

      const mpgrRows = rows.filter((r) => r.from.toLowerCase() === COVERAGE_MPGR.toLowerCase() || r.to.toLowerCase() === COVERAGE_MPGR.toLowerCase());
      console.log(`::notice::V2 coverage shard ${SHARD}/${SHARDS} measured at block ${blockNumber}: ${summary.executable} executable, ${summary.missingLiquidity} missing liquidity, ${summary.unsupportedToken} unsupported token, ${summary.unmeasured} unmeasured of ${summary.pairs} pairs (${shard.length} owned of ${plan.length} planned) in ${artifact.elapsedMs}ms`);
      console.log(`::notice::MPGR pairs in this shard: ${mpgrRows.map((r) => `${r.direction} ${r.fromSymbol ?? r.from.slice(0, 8)}->${r.toSymbol ?? r.to.slice(0, 8)} ${r.category}`).join(", ") || "none"}`);
      for (const u of summarizeUnmeasuredReasons(rows)) console.log(`::notice::unmeasured[${u.count}]: ${u.reason}`);
      console.log(`::notice::v4 discovery RPC calls this shard: ${v4Cache.totals.getCode} eth_getCode, ${v4Cache.totals.getLogs} eth_getLogs`);

      // A broken fee invariant is a defect and must fail the run.
      expect(summary.feeDefects, rows.filter(r => r.category === "FEE_INVARIANT_DEFECT").map(r => r.reason).join("; ")).toBe(0);
      // Every executable route must respect the contract's shape and the enabled venues.
      for (const row of rows.filter(r => r.category === "EXECUTABLE_ROUTE")) {
        expect(row.hops!).toBeGreaterThanOrEqual(1);
        expect(row.hops!).toBeLessThanOrEqual(3);
        expect(row.legs!).toBeGreaterThanOrEqual(1);
        expect(row.legs!).toBeLessThanOrEqual(4);
        for (const kind of row.venueKinds!) expect(SWAP_V2_ENABLED_KINDS as readonly number[]).toContain(kind);
      }
      // Disabled venues must never appear as a routed venue.
      for (const row of rows) {
        for (const kind of row.venueKinds ?? []) {
          expect(["pancakeV3", "zerox"].includes(kind === 5 ? "pancakeV3" : kind === 6 ? "zerox" : "")).toBe(false);
        }
      }
      // Unmeasured rows must be labelled unmeasured — never counted as coverage.
      for (const row of rows.filter(r => r.category === "UNMEASURED_PROVIDER_FAILURE")) expect(row.measured).toBe(false);
      // Token facts must agree with the pair verdicts.
      for (const t of tokens) {
        const fact = facts.get(t.address.toLowerCase());
        if (!fact) continue;
        const classified = classifyTokenSupport(fact);
        if (!classified.supported && classified.category === "UNSUPPORTED_TOKEN_INFRASTRUCTURE") {
          const involving = rows.filter(r => r.from.toLowerCase() === t.address.toLowerCase() || r.to.toLowerCase() === t.address.toLowerCase());
          expect(involving.every(r => r.category !== "EXECUTABLE_ROUTE"), `${t.symbol} routed despite unsupported infrastructure`).toBe(true);
        }
      }
      // This shard must have reported exactly the pairs it owns — no more, no less.
      expect(rows.map(r => r.index)).toEqual(shard.map(p => p.index));
      expect(summary.pairs).toBe(shard.length);
      expect(SWAP_V2_SEALED_MANIFEST.chainId).toBe(8453);
      // A discovery outage must not be laundered into a liquidity verdict.
      expect(rows.filter(r => r.category === "MISSING_LIQUIDITY").every(r => r.measured)).toBe(true);
      expect(V2QuoteError).toBeTypeOf("function");
    },
    1_800_000,
  );
});
