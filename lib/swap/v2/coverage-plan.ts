// lib/swap/v2/coverage-plan.ts
// The deterministic probe plan for the V2 coverage matrix.
//
// WHY THIS IS ITS OWN MODULE. The matrix is sharded across parallel CI jobs, and
// the aggregator has to rebuild the SAME plan without touching an RPC to notice
// which pairs no shard reported. A plan that lived inside the live test file could
// only be recomputed by running the live test. So the plan is pure: no network, no
// clock, no randomness — the same input always yields the same indices, which is
// what makes `index % shards` a valid sharding function.
//
// WHAT IT IS NOT. This is a SAMPLE of Base, deliberately assembled from tokens the
// app already knows plus MPGR (imported by address, in no catalog). It is never
// presented as the whole Base token universe, and a pair missing from this list
// says nothing about whether it would route.
import "server-only";
import type { Address } from "viem";
import { MANUAL_SWAP_TOKENS } from "@/lib/trade/manual-swap";
import { BASE_MAINNET_B20_TOKENS } from "@/lib/executor/executor-config";

/** MPGR: imported by address. Not in any app catalog, and its only Base liquidity
 * is a Uniswap v4 pool, so it is the sharpest test of universal discovery. */
export const COVERAGE_MPGR = "0xb2000000000000000000008d204203177a78af01" as Address;
export const COVERAGE_WETH = "0x4200000000000000000000000000000000000006" as Address;
export const COVERAGE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;

/** SELL = the token under test is sold for a quote asset. BUY = a quote asset is
 * spent to buy it. TOKEN_PAIR = neither side is a quote asset, which is the
 * universal-discovery case where no major-asset hop may be assumed. */
export type CoverageDirection = "SELL" | "BUY" | "TOKEN_PAIR";

export interface CoverageToken { address: Address; symbol: string }

export interface CoveragePair {
  /** Stable position in the plan. Sharding and merging both key on it. */
  index: number;
  from: Address;
  to: Address;
  fromSymbol: string;
  toSymbol: string;
  /** The token this probe is about; for TOKEN_PAIR probes it is `from`. */
  subject: Address;
  subjectSymbol: string;
  direction: CoverageDirection;
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const coveragePairId = (from: string, to: string): string => `${from.toLowerCase()}->${to.toLowerCase()}`;

/**
 * Probe subjects: any Base address, catalogued or imported. Nothing here is a
 * routing restriction — discovery decides, per pair, at run time. MPGR comes
 * first so it is never the pair a budget cut drops.
 */
export function coverageProbeTokens(): CoverageToken[] {
  const seen = new Map<string, CoverageToken>();
  const add = (address: string, symbol: string): void => {
    const key = address.toLowerCase();
    if (!seen.has(key)) seen.set(key, { address: address as Address, symbol });
  };
  add(COVERAGE_MPGR, "MPGR");
  add(COVERAGE_WETH, "WETH");
  add(COVERAGE_USDC, "USDC");
  for (const t of MANUAL_SWAP_TOKENS) add(t.address, t.symbol);
  for (const t of BASE_MAINNET_B20_TOKENS as readonly { address: string; symbol: string }[]) add(t.address, t.symbol);
  return [...seen.values()];
}

/**
 * The plan: every token against both quote assets in BOTH directions (so BUY and
 * SELL are measured separately, as the app requires them to agree), plus a bounded
 * sample of arbitrary token/token pairs where neither side is a quote asset.
 *
 * Identical probes are emitted once: WETH/USDC and USDC/WETH would otherwise be
 * generated twice (once from each side's loop) and waste two budget slots on a
 * measurement that has already been made.
 */
export function coveragePairPlan(tokens: readonly CoverageToken[], maxTokenTokenPairs = 12): CoveragePair[] {
  const symbol = new Map(tokens.map((t) => [t.address.toLowerCase(), t.symbol]));
  const at = (address: string): string => symbol.get(address.toLowerCase()) ?? address.slice(0, 10);
  const pairs: CoveragePair[] = [];
  const seen = new Set<string>();
  const push = (from: Address, to: Address, subject: Address, direction: CoverageDirection): void => {
    const id = coveragePairId(from, to);
    if (seen.has(id)) return; // the same probe is never run twice
    seen.add(id);
    pairs.push({
      index: pairs.length, from, to, fromSymbol: at(from), toSymbol: at(to),
      subject, subjectSymbol: at(subject), direction,
    });
  };
  const isQuote = (a: string): boolean => eq(a, COVERAGE_USDC) || eq(a, COVERAGE_WETH);

  for (const t of tokens) {
    for (const quote of [COVERAGE_USDC, COVERAGE_WETH]) {
      if (eq(t.address, quote)) continue;
      push(t.address, quote, t.address, "SELL");
      push(quote, t.address, t.address, "BUY");
    }
  }
  let budget = maxTokenTokenPairs;
  for (let i = 0; i < tokens.length && budget > 0; i++) {
    for (let j = i + 1; j < tokens.length && budget > 0; j++) {
      const a = tokens[i];
      const b = tokens[j];
      if (isQuote(a.address) || isQuote(b.address)) continue;
      push(a.address, b.address, a.address, "TOKEN_PAIR");
      budget--;
    }
  }
  return pairs;
}

/**
 * Shard selection, grouped by SUBJECT TOKEN.
 *
 * Deterministic and disjoint: every pair belongs to exactly one shard, and the union
 * of all shards is the whole plan. Subjects are dealt round-robin in plan order, so
 * subject counts differ by at most one between shards.
 *
 * WHY NOT ROUND-ROBIN BY PAIR INDEX. The plan is ordered by token, so dealing pairs
 * round-robin spread every token across every shard. That looks balanced — equal pair
 * counts — but the expensive part of measuring a pair is per TOKEN, not per pair:
 * deriving a token's deployment floor is a ~26-step `eth_getCode` binary search, and
 * its v4 `Initialize` scan is up to `maxLogCalls` sequential `eth_getLogs` round-trips
 * against a provider that serves ten blocks at a time. Both are cached per token, so a
 * shard that sees the whole catalogue pays the whole catalogue's discovery cost. Run
 * `39454971188` measured the price of that: shard 4 left 25 of its 53 pairs unattempted
 * and shard 1 left 13, purely because the wall clock ran out first — a scheduling
 * artefact that the report can only classify as UNMEASURED.
 *
 * THE TRADE IS EXPLICIT. A token's rows now live in one shard, so a shard that dies
 * takes that token's evidence with it instead of leaving three partial copies. That is
 * survivable only because the aggregate job fails loudly when fewer shards report than
 * the plan expects, and renders every lost pair as an explicit gap rather than quietly
 * shrinking the matrix.
 */
export function coverageShard(pairs: readonly CoveragePair[], shard: number, shards: number): CoveragePair[] {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be a positive integer, got ${shards}`);
  if (!Number.isInteger(shard) || shard < 1 || shard > shards) throw new Error(`shard ${shard} is outside 1..${shards}`);
  const owner = new Map<string, number>();
  const owned: CoveragePair[] = [];
  for (const pair of pairs) {
    const key = pair.subject.toLowerCase();
    let slot = owner.get(key);
    if (slot === undefined) {
      slot = owner.size % shards;
      owner.set(key, slot);
    }
    if (slot === shard - 1) owned.push(pair);
  }
  return owned;
}
