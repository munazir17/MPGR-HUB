// Live V2 coverage matrix.
//
// Runs the app's REAL discovery stack (`RpcV2LiquiditySource` + `discoverV2Quote`)
// against Base and classifies every probed pair. This is the evidence behind any
// claim about which tokens are actually tradeable.
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
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { BASE_MAINNET_B20_TOKENS } from "@/lib/executor/executor-config";
import { discoverV2Quote, V2QuoteError } from "@/lib/swap/v2/discovery";
import { RpcV2LiquiditySource } from "@/lib/swap/v2/rpc-source";
import { SWAP_V2_ENABLED_KINDS, SWAP_V2_SEALED_MANIFEST } from "@/lib/swap/v2/deployment";
import { classifyPairOutcome, classifyTokenSupport, renderCoverageMarkdown, summarizeCoverage, type PairCoverageRow, type TokenSupportFacts } from "@/lib/swap/v2/coverage";
import { erc20Abi } from "@/lib/erc20-abi";

const RPC_URL = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
// OPT-IN. This filename matches vitest's test-file glob, so without a gate the
// ordinary `npm test` run would attempt the full live matrix — which is exactly
// what cancelled CI's quality job on the first attempt. The dedicated coverage
// workflow sets MPGR_V2_COVERAGE=1; everywhere else this skips immediately.
const ENABLED = process.env.MPGR_V2_COVERAGE === "1" || process.env.MPGR_V2_COVERAGE === "true";
/** Wall-clock budget per pair, so one slow pair cannot consume the whole run. A
 * timeout is recorded as UNMEASURED — never as missing liquidity. */
const PER_PAIR_TIMEOUT_MS = Number(process.env.MPGR_V2_COVERAGE_PAIR_TIMEOUT_MS ?? 45_000);
const MPGR = "0xb2000000000000000000008d204203177a78af01" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const OUT_DIR = "deployments/.local";
/** Bound the probe set so the run stays inside CI time limits. This is a SAMPLE;
 * it is never presented as the whole Base token universe. */
const MAX_TOKEN_TOKEN_PAIRS = Number(process.env.MPGR_V2_COVERAGE_MAX_PAIRS ?? 12);
/** Hard caps so the run always finishes and always emits a matrix. Pairs that the
 * budget does not reach are recorded UNMEASURED, never silently dropped. */
const MAX_TOTAL_PAIRS = Number(process.env.MPGR_V2_COVERAGE_TOTAL_PAIRS ?? 30);
// Kept below vitest's 900s test timeout so the matrix is written before any
// timeout could discard it.
const TOTAL_BUDGET_MS = Number(process.env.MPGR_V2_COVERAGE_BUDGET_MS ?? 600_000);
const PROBE_AMOUNT = 1_000_000n;

async function reachable(): Promise<{ ok: true; client: ReturnType<typeof buildClient> } | { ok: false; reason: string }> {
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

function buildClient() {
  return createPublicClient({ chain: base, transport: http(RPC_URL, { timeout: 30_000 }) });
}

/** Reads the on-chain facts that separate "unsupported token" from "no liquidity". */
async function tokenFacts(client: ReturnType<typeof buildClient>, address: Address, blockNumber: bigint): Promise<TokenSupportFacts> {
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

/** A probe subject: any Base address, catalogued or imported. Nothing here is a
 * routing restriction — discovery decides, per pair, at run time. */
function probeTokens(): { address: Address; symbol: string }[] {
  const seen = new Map<string, { address: Address; symbol: string }>();
  const add = (address: string, symbol: string) => {
    const key = address.toLowerCase();
    if (!seen.has(key)) seen.set(key, { address: address as Address, symbol });
  };
  add(MPGR, "MPGR");            // imported by address, not in the app catalog
  add(WETH, "WETH");
  add(USDC, "USDC");
  for (const t of MANUAL_SWAP_TOKENS) add(t.address, t.symbol);
  for (const t of BASE_MAINNET_B20_TOKENS as readonly { address: string; symbol: string }[]) add(t.address, t.symbol);
  return [...seen.values()];
}

function pairPlan(tokens: { address: Address; symbol: string }[]): { from: Address; to: Address }[] {
  const pairs: { from: Address; to: Address }[] = [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // Every token against the two common quote assets, in both directions (BUY/SELL).
  for (const t of tokens) {
    for (const quote of [USDC, WETH]) {
      if (eq(t.address, quote)) continue;
      pairs.push({ from: t.address, to: quote }, { from: quote, to: t.address });
    }
  }
  // A bounded sample of arbitrary token/token pairs — the universal-discovery case
  // where neither side is a major asset.
  let budget = MAX_TOKEN_TOKEN_PAIRS;
  for (let i = 0; i < tokens.length && budget > 0; i++) {
    for (let j = i + 1; j < tokens.length && budget > 0; j++) {
      const a = tokens[i], b = tokens[j];
      if (eq(a.address, USDC) || eq(a.address, WETH) || eq(b.address, USDC) || eq(b.address, WETH)) continue;
      pairs.push({ from: a.address, to: b.address });
      budget--;
    }
  }
  return pairs;
}

describe("V2 live coverage matrix", () => {
  it(
    "classifies real Base pairs and refuses to claim unmeasured coverage",
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
      const tokens = probeTokens();
      const pairs = pairPlan(tokens);
      const facts = new Map<string, TokenSupportFacts>();
      for (const t of tokens) facts.set(t.address.toLowerCase(), await tokenFacts(client, t.address, blockNumber));

      const plan = pairs.slice(0, MAX_TOTAL_PAIRS);
      const deferred = pairs.slice(MAX_TOTAL_PAIRS);
      const startedAt = Date.now();
      const rows: PairCoverageRow[] = [];
      for (const { from, to } of plan) {
        if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
          // Out of budget: record what is left as UNMEASURED and stop. Reporting
          // fewer pairs honestly beats timing out and reporting none.
          rows.push({ from, to, category: "UNMEASURED_PROVIDER_FAILURE", measured: false, reason: "Probe budget exhausted before this pair was measured." });
          continue;
        }
        const source = new RpcV2LiquiditySource(client as never, blockNumber);
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
        rows.push(classifyPairOutcome(from, to, outcome, {
          from: facts.get(from.toLowerCase()), to: facts.get(to.toLowerCase()),
        }));
      }

      for (const { from, to } of deferred) {
        rows.push({ from, to, category: "UNMEASURED_PROVIDER_FAILURE", measured: false, reason: `Pair beyond the ${MAX_TOTAL_PAIRS}-pair probe cap; not measured.` });
      }

      const summary = summarizeCoverage(rows);
      const rpcLabel = process.env.BASE_MAINNET_RPC_URL ? "secrets.BASE_MAINNET_RPC_URL" : "https://mainnet.base.org (public)";
      const markdown = renderCoverageMarkdown(rows, { chainId: 8453, blockNumber: blockNumber.toString(), rpcLabel });

      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(`${OUT_DIR}/swap-v2-coverage-matrix.json`, JSON.stringify({ chainId: 8453, blockNumber: blockNumber.toString(), rpcLabel, summary, rows }, null, 2));
      writeFileSync(`${OUT_DIR}/swap-v2-coverage-matrix.md`, markdown);

      console.log(`::notice::V2 coverage measured at block ${blockNumber}: ${summary.executable} executable, ${summary.missingLiquidity} missing liquidity, ${summary.unsupportedToken} unsupported token, ${summary.unmeasured} unmeasured of ${summary.pairs} pairs`);

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
        const classified = classifyTokenSupport(facts.get(t.address.toLowerCase())!);
        if (!classified.supported && classified.category === "UNSUPPORTED_TOKEN_INFRASTRUCTURE") {
          const involving = rows.filter(r => r.from.toLowerCase() === t.address.toLowerCase() || r.to.toLowerCase() === t.address.toLowerCase());
          expect(involving.every(r => r.category !== "EXECUTABLE_ROUTE"), `${t.symbol} routed despite unsupported infrastructure`).toBe(true);
        }
      }
      expect(summary.pairs).toBe(rows.length);
      expect(SWAP_V2_SEALED_MANIFEST.chainId).toBe(8453);
      // A discovery outage must not be laundered into a liquidity verdict.
      expect(rows.filter(r => r.category === "MISSING_LIQUIDITY").every(r => r.measured)).toBe(true);
      expect(V2QuoteError).toBeTypeOf("function");
    },
    900_000,
  );
});
