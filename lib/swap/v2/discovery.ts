// Unreleased V2 path. Pure routing policy over liquidity-discovered pools, NOT
// the legacy catalog. A source must return all matching on-chain pool keys or
// throw DISCOVERY_UNAVAILABLE; an RPC/index failure is not a no-liquidity proof.
import { isAddress, type Address, type Hex } from "viem";
import { BASE_USDC, BASE_WETH, isNativeEthSentinel } from "@/lib/trade/trade-config";
import { SWAP_V2_SEALED_MANIFEST } from "./sealed-manifest";
export const V2_FEE_BPS = 25;
export const V2_FEE_RECIPIENT = "0x96F7fb5C4277BD1190fb6eF4820eBC96bA6964A4" as Address;
/** ACTIVATED by the reviewed activation commit, and only after both canary receipts
 * exist. Reverting this one expression is the entire rollback: V1 needs none, because
 * V1 was never touched, and no contract action is required or permitted. */
export const V2_DEPLOYMENT = SWAP_V2_SEALED_MANIFEST;
export const V4_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Address;
export interface V4Key { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export interface Pool {
  id: string; pool: Address; router: Address; factory: Address; kind: 1 | 2 | 3 | 4 | 7;
  token0: Address; token1: Address; poolFee: number; tickSpacing: number; stable: boolean;
  v4Key?: V4Key;
}
/**
 * Why one discovered candidate pool did not become a leg.
 *
 * Exactly one of these is recorded per candidate. Before this existed, every one of
 * them collapsed into the same silent `null` from `quoteLeg`, so "the venue refused
 * the swap" and "no pool was ever found" produced an identical error — which is why
 * MPGR's SELL direction could only be reported as an undifferentiated provider
 * failure while its BUY direction measured executable through the very same pool.
 */
export type CandidateOutcome =
  /** The venue answered with a positive output. */
  | { cause: "quoted"; amountOut: bigint }
  /** The venue answered zero. That is a liquidity statement, not an outage. */
  | { cause: "zero-output" }
  /** The venue reverted. It refused to answer, so nothing was learned. */
  | { cause: "reverted"; detail: string }
  /** The provider failed the call. Unmeasured, never a verdict. */
  | { cause: "rpc-error"; detail: string }
  /** A read/log/wall-clock cap was hit before the venue could answer. */
  | { cause: "budget"; detail: string }
  /** The venue adapter itself refused to try (noncanonical venue, dead quoter). */
  | { cause: "venue-error"; code: "FEE_POLICY_INVALID" | "DISCOVERY_UNAVAILABLE"; detail: string };

/** Why a discovered pool was dropped before it was ever quoted. */
export type PoolRejectionCause =
  | "venue-kind-not-enabled" | "same-token-pool" | "v4-key-missing" | "v4-not-pool-manager"
  | "v4-currency-order" | "v4-tick-spacing" | "v4-key-mismatch" | "does-not-connect-pair";

export interface RouteAttemptTrace {
  tokenIn: Address; tokenOut: Address; gross: bigint; net: bigint;
  /** Pools discovery returned for the direct pair, before any validation. */
  poolsReturned: number;
  /** Pools dropped before quoting, each with the reason it was dropped. */
  rejected: { poolId: string; kind: number; cause: PoolRejectionCause; detail: string }[];
  /** Pools that passed validation and connect tokenIn→tokenOut, and what each did. */
  candidates: { poolId: string; kind: number; hooks: Address | null; outcome: CandidateOutcome }[];
  /** False when discovery could not finish, so "no route" is not a provable negative. */
  negativeProvable: boolean;
  /** Discovery-side notes: v4 search state, sweep state, index failures. */
  notes: string[];
  /** Every discovery stage that ran, in order, and what each cost and produced. */
  stages: StageTrace[];
  multihop: { attempted: boolean; candidates: number; note: string | null };
}

/** The single label a failed pair is reported under. Coarser than the trace, and
 * stable enough to group a whole coverage matrix by. */
export type RouteFailureAttribution =
  | "POOL_NOT_DISCOVERED" | "EXECUTOR_VALIDATION_REJECTED" | "VENUE_REJECTED_SWAP"
  | "HOOK_OR_TOKEN_INCOMPATIBLE" | "QUOTE_ZERO_OUTPUT" | "QUOTE_RPC_FAILED"
  | "BUDGET_EXHAUSTED" | "MULTIHOP_ENUMERATION_UNAVAILABLE";

/** Which ordered discovery step a pool came from. Named for attribution and for the
 * report, because "we found a pool" without "which family answered" hides the cost. */
export type DiscoveryStageName = "hints" | "factory-index" | "v4-canonical-logs" | "canonical-sweep";

/**
 * One ordered step of direct-pair discovery, cheapest first.
 *
 * A source that can answer from an earlier stage never pays for a later one. That is
 * what makes a pasted address quotable in one round trip: the getter-backed venues are
 * a handful of `eth_call`s, while the v4 `Initialize` search and the whole-history
 * canonical sweep are each hundreds of `eth_getLogs` calls on a range-capped provider.
 */
export interface DiscoveryStage {
  name: DiscoveryStageName;
  pools(): Promise<readonly Pool[]>;
  /** Whether this stage enumerated its venue family to completion for this pair. A
   * stage that is not complete can still produce a POSITIVE; it can never support a
   * claim that no pool exists. */
  complete(): boolean;
}

export interface StageTrace {
  name: DiscoveryStageName;
  poolsReturned: number;
  /** Pools that passed executor validation and actually connect the pair. */
  quotable: number;
  complete: boolean;
  /** Set when the stage could not run; the reason, verbatim. */
  note?: string;
}

export interface LiquiditySource {
  hints?(input: Address, output: Address): Promise<readonly Pool[]>;
  /** Ordered direct-pair discovery. Absent means the source is single-stage and
   * `pools(input, output)` is the whole answer, which is what every simple source and
   * test double does. */
  directStages?(input: Address, output: Address): readonly DiscoveryStage[];
  pools(input: Address, output?: Address): Promise<readonly Pool[]>;
  quote(pool: Pool, input: Address, amount: bigint): Promise<bigint>;
  /** Richer than `quote`: says WHY a venue did not answer, instead of collapsing a
   * revert, a zero and an outage into one number. Optional, so every existing source
   * and test double keeps working unchanged. */
  quoteAttempt?(pool: Pool, input: Address, amount: bigint): Promise<CandidateOutcome>;
  /** Whether "no compatible pool exists" is provable for this pair right now.
   * Absent means the source claims to have enumerated completely, which is the
   * pre-existing contract; a bounded source must say so explicitly. */
  negativeProvable?(input: Address, output?: Address): boolean;
  /** Discovery-side notes for the pair, used verbatim in failure attribution. */
  discoveryNotes?(input: Address, output?: Address): string[];
}
export interface Leg { pools: readonly Pool[]; tokens: readonly Address[]; amountIn: bigint; amountOut: bigint }
export interface V2Quote {
  tokenIn: Address; tokenOut: Address; gross: bigint; feeBps: 25; feeRecipient: Address;
  fee: bigint; net: bigint; amountOut: bigint; legs: readonly Leg[];
  /** Basis points the full size loses versus a 0.1% probe on the same path. */
  priceImpactBps?: number | null;
}
export class V2QuoteError extends Error {
  /** Present on routing failures: what was discovered, what each candidate did, and
   * therefore which of the five failure classes this actually is. */
  trace?: RouteAttemptTrace;
  attribution?: RouteFailureAttribution;
  constructor(public code: "INVALID_PAIR" | "INVALID_AMOUNT" | "LIQUIDITY_UNAVAILABLE" | "DISCOVERY_UNAVAILABLE" | "FEE_POLICY_INVALID", message: string) { super(message); }
}
export function asset(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new V2QuoteError("INVALID_PAIR", "Invalid Base asset address");
  return (isNativeEthSentinel(value) ? BASE_WETH : value).toLowerCase() as Address;
}
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const other = (p: Pool, token: Address): Address | null => eq(p.token0, token) ? p.token1 : eq(p.token1, token) ? p.token0 : null;
/**
 * The executor-shape check, returning WHY a pool is unusable instead of a boolean.
 *
 * The v4 branch is the one that matters for a native-side pool: `currency0` is the
 * zero address for a pool against native ETH, which sorts below every ERC-20, and the
 * pool's `token0` must read as canonical WETH — the same normalisation the deployed
 * executor relies on when it settles such a hop into WETH. A pool that fails any of
 * this could never be addressed by the deployed contract, so it is dropped before any
 * quote is attempted and the reason is kept.
 */
export function poolRejection(p: Pool): { cause: PoolRejectionCause; detail: string } | null {
  if (![1, 2, 3, 4, 7].includes(p.kind)) return { cause: "venue-kind-not-enabled", detail: `venue kind ${p.kind} is not enabled on the deployed executor` };
  if (eq(p.token0, p.token1)) return { cause: "same-token-pool", detail: "pool has the same token on both sides" };
  if (p.kind !== 7) return null;
  const key = p.v4Key;
  if (!key) return { cause: "v4-key-missing", detail: "v4 pool without a PoolKey" };
  if (!eq(p.pool, V4_MANAGER) || !eq(p.router, V4_MANAGER) || !eq(p.factory, V4_MANAGER)) {
    return { cause: "v4-not-pool-manager", detail: `v4 hop must address the PoolManager (${V4_MANAGER}) as pool, router and factory` };
  }
  if (BigInt(key.currency0) >= BigInt(key.currency1)) return { cause: "v4-currency-order", detail: "PoolKey currencies are not in ascending order" };
  if (key.tickSpacing <= 0 || key.tickSpacing > 32767) return { cause: "v4-tick-spacing", detail: `tickSpacing ${key.tickSpacing} outside [1,32767]` };
  const token0 = key.currency0 === "0x0000000000000000000000000000000000000000" ? BASE_WETH : key.currency0;
  if (!eq(token0, p.token0) || !eq(key.currency1, p.token1)) {
    return { cause: "v4-key-mismatch", detail: "pool tokens do not match its own PoolKey currencies" };
  }
  return null;
}
function validPool(p: Pool): boolean { return poolRejection(p) === null; }
async function quoteLeg(source: LiquiditySource, pools: readonly Pool[], tokens: readonly Address[], amountIn: bigint): Promise<Leg | null> {
  let amount = amountIn;
  for (let i = 0; i < pools.length; i++) {
    try { amount = await source.quote(pools[i], tokens[i], amount); } catch (error) { if (error instanceof V2QuoteError) throw error; throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "Venue quote unavailable"); }
    if (amount <= 0n) return null;
  }
  return { pools, tokens, amountIn, amountOut: amount };
}
export function validateV2Quote(q: V2Quote): void {
  const expected = q.gross * 25n / 10000n;
  if (q.feeBps !== 25 || !eq(q.feeRecipient, V2_FEE_RECIPIENT) || expected <= 0n || q.fee !== expected || q.net !== q.gross - expected ||
      q.legs.reduce((s, l) => s + l.amountIn, 0n) !== q.net || q.amountOut <= 0n ||
      q.legs.reduce((s, l) => s + l.amountOut, 0n) !== q.amountOut || q.legs.length === 0 || q.legs.length > 4 ||
      q.legs.some(l => l.amountIn <= 0n || l.amountOut <= 0n || l.pools.length < 1 || l.pools.length > 3 || l.tokens.length !== l.pools.length + 1 ||
        !eq(l.tokens[0], q.tokenIn) || !eq(l.tokens[l.tokens.length - 1], q.tokenOut) ||
        new Set(l.tokens.map(t => t.toLowerCase())).size !== l.tokens.length ||
        l.pools.some((p, i) => !validPool(p) || !eq(other(p, l.tokens[i]) ?? "", l.tokens[i + 1])))) {
    throw new V2QuoteError("FEE_POLICY_INVALID", "Invalid gross-input fee, allocation, or typed path");
  }
}
const legOf = (pool: Pool, tokenIn: Address, tokenOut: Address, net: bigint, amountOut: bigint): Leg =>
  ({ pools: [pool], tokens: [tokenIn, tokenOut], amountIn: net, amountOut });

/**
 * Quotes one direct candidate and records WHY it did or did not become a leg.
 *
 * Deliberately never throws. A candidate that fails is evidence about that venue, and
 * the old `Promise.all(direct.map(quoteLeg))` let one venue's outage reject the whole
 * batch — erasing another venue's good quote and reporting the pair as an
 * undifferentiated provider failure.
 */
async function attemptCandidate(
  source: LiquiditySource, pool: Pool, tokenIn: Address, tokenOut: Address, net: bigint,
): Promise<{ leg: Leg | null; outcome: CandidateOutcome }> {
  try {
    if (source.quoteAttempt) {
      const outcome = await source.quoteAttempt(pool, tokenIn, net);
      return { leg: outcome.cause === "quoted" ? legOf(pool, tokenIn, tokenOut, net, outcome.amountOut) : null, outcome };
    }
    // A source that only implements `quote` gets the same vocabulary derived from its
    // single number: positive means quoted, anything else means the venue answered
    // zero. It cannot distinguish a revert from an outage, and says so by omission.
    const amountOut = await source.quote(pool, tokenIn, net);
    const outcome: CandidateOutcome = amountOut > 0n ? { cause: "quoted", amountOut } : { cause: "zero-output" };
    return { leg: outcome.cause === "quoted" ? legOf(pool, tokenIn, tokenOut, net, amountOut) : null, outcome };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const outcome: CandidateOutcome = !(error instanceof V2QuoteError)
      ? { cause: "rpc-error", detail }
      : error.code === "FEE_POLICY_INVALID"
        ? { cause: "venue-error", code: "FEE_POLICY_INVALID", detail }
        : /budget|exceeded|cap/i.test(detail)
          ? { cause: "budget", detail }
          : { cause: "rpc-error", detail };
    return { leg: null, outcome };
  }
}

const describe = (t: RouteAttemptTrace): string => {
  const venueName = (kind: number) => ({ 1: "Aerodrome Slipstream", 2: "Uniswap v3", 3: "Uniswap v2", 4: "Aerodrome Classic", 7: "Uniswap v4" }[kind] ?? `kind ${kind}`);
  const candidate = (c: RouteAttemptTrace["candidates"][number]): string => {
    const shape = `${c.poolId} (${venueName(c.kind)}${c.hooks && c.hooks.toLowerCase() !== "0x0000000000000000000000000000000000000000" ? `, hooks ${c.hooks}` : ""})`;
    switch (c.outcome.cause) {
      case "quoted": return `${shape} quoted ${c.outcome.amountOut}`;
      case "zero-output": return `${shape} answered zero output`;
      case "reverted": return `${shape} REVERTED: ${c.outcome.detail}`;
      case "rpc-error": return `${shape} could not be quoted (provider failure): ${c.outcome.detail}`;
      case "budget": return `${shape} was never quoted (budget exhausted): ${c.outcome.detail}`;
      case "venue-error": return `${shape} was refused by its own venue adapter: ${c.outcome.detail}`;
    }
  };
  return t.candidates.map(candidate).join("; ");
};

/**
 * Turns a trace into the error a caller should see: the right `code`, and a message
 * that names WHICH of the failure classes actually happened.
 *
 * The governing rule is that a refusal is not a fact about liquidity. A venue that
 * reverts, a provider that errors and a budget that runs out all leave the pair
 * UNMEASURED (`DISCOVERY_UNAVAILABLE`). Only a venue that *answers* — with zero — has
 * said something about liquidity, and even then only when discovery was complete
 * enough to prove a negative.
 */
export function attributeRouteFailure(t: RouteAttemptTrace): V2QuoteError {
  const finish = (code: V2QuoteError["code"], attribution: RouteFailureAttribution, message: string): V2QuoteError => {
    const error = new V2QuoteError(code, message);
    error.trace = t; error.attribution = attribution;
    return error;
  };
  const evidence = describe(t);
  const notes = t.notes.length ? ` Discovery could not finish: ${t.notes.join(" | ")}` : "";
  const multihop = t.multihop.note ? ` Multi-hop was also unavailable: ${t.multihop.note}` : "";
  const notProvable = " This is UNMEASURED, not missing liquidity.";

  // 1. A candidate was never quoted because a cap was hit. Nothing downstream was
  //    asked, so nothing was learned.
  const budgeted = t.candidates.find((c) => c.outcome.cause === "budget");
  if (budgeted) {
    return finish("DISCOVERY_UNAVAILABLE", "BUDGET_EXHAUSTED",
      `Route discovery ran out of budget before this pair could be measured. Direct candidates: ${evidence}.${notes}${multihop}`);
  }
  // 2. The provider failed the quote call itself.
  const rpc = t.candidates.find((c) => c.outcome.cause === "rpc-error");
  if (rpc) {
    return finish("DISCOVERY_UNAVAILABLE", "QUOTE_RPC_FAILED",
      `A pool WAS discovered for this pair but the venue quote could not be read. Direct candidates: ${evidence}.${notes}${multihop}${notProvable}`);
  }
  // 3. The venue adapter refused to try at all (noncanonical venue, dead quoter).
  const adapter = t.candidates.find((c) => c.outcome.cause === "venue-error");
  if (adapter && adapter.outcome.cause === "venue-error") {
    return finish(adapter.outcome.code, "EXECUTOR_VALIDATION_REJECTED",
      `A pool WAS discovered but its venue adapter refused the call. Direct candidates: ${evidence}.${notes}${multihop}`);
  }
  // 4. The venue reverted. A hook contract sits in the call path of a v4 swap, so a
  //    reverting v4 pool with non-zero hooks is attributed to the hook or to the
  //    token's own transfer rules — which is as far as the evidence goes. Isolating
  //    it further needs a state-trace of the revert, not a guess.
  const reverted = t.candidates.filter((c) => c.outcome.cause === "reverted");
  if (reverted.length) {
    const hooked = reverted.some((c) => c.kind === 7 && !!c.hooks && c.hooks.toLowerCase() !== "0x0000000000000000000000000000000000000000");
    return finish("DISCOVERY_UNAVAILABLE", hooked ? "HOOK_OR_TOKEN_INCOMPATIBLE" : "VENUE_REJECTED_SWAP",
      `A pool WAS discovered and passed executor validation, but the venue refused the swap. Direct candidates: ${evidence}.`
      + (hooked ? " The reverting pool is a Uniswap v4 pool with a hooks contract in its call path, so the refusal is attributable to that hook or to the token's own transfer rules; it was not isolated further." : "")
      + `${notes}${multihop}${notProvable}`);
  }
  // 5. No candidate was ever quoted, so from here the discovery notes are the only
  //    evidence. A search that was cut short is a budget fact, not a pool fact.
  if (!t.candidates.length && t.notes.some((n) => /budget|exceeded|capped|refused every|unavailable|could not be established/i.test(n))) {
    return finish("DISCOVERY_UNAVAILABLE", "BUDGET_EXHAUSTED",
      `Route discovery could not finish, so this pair was never measured.${notes}${multihop}`);
  }
  const validationRejected = t.rejected.filter((r) => r.cause !== "does-not-connect-pair");
  // 6. Pools were found for this pair but none could be quoted: the venue answered
  //    zero. That is a liquidity statement — but only if the search was complete.
  if (t.candidates.length) {
    return t.negativeProvable
      ? finish("LIQUIDITY_UNAVAILABLE", "QUOTE_ZERO_OUTPUT",
          `Pools exist for this pair but none quoted a positive output. Direct candidates: ${evidence}.${multihop}`)
      : finish("DISCOVERY_UNAVAILABLE", "QUOTE_ZERO_OUTPUT",
          `Pools exist for this pair but none quoted a positive output, and discovery was not complete enough to prove no better pool exists. Direct candidates: ${evidence}.${notes}${multihop}${notProvable}`);
  }
  // 7. Nothing quotable was discovered at all: either dropped by executor validation,
  //    or no pool for this pair was ever found.
  if (validationRejected.length) {
    const detail = validationRejected.map((r) => `${r.poolId} (${r.cause}: ${r.detail})`).join("; ");
    return t.negativeProvable
      ? finish("LIQUIDITY_UNAVAILABLE", "EXECUTOR_VALIDATION_REJECTED",
          `Discovery returned pool(s) the deployed executor could not address, so no route was quotable: ${detail}.${multihop}`)
      : finish("DISCOVERY_UNAVAILABLE", "EXECUTOR_VALIDATION_REJECTED",
          `Discovery returned pool(s) the deployed executor could not address, and discovery was incomplete besides: ${detail}.${notes}${multihop}${notProvable}`);
  }
  return t.negativeProvable
    ? finish("LIQUIDITY_UNAVAILABLE", "POOL_NOT_DISCOVERED",
        `No compatible pool was discovered for this pair and discovery was complete, so no liquid direct or up-to-three-hop route exists.${t.poolsReturned ? ` ${t.poolsReturned} pool(s) were returned but none connects ${t.tokenIn} to ${t.tokenOut}.` : ""}${multihop}`)
    : finish("DISCOVERY_UNAVAILABLE", "POOL_NOT_DISCOVERED",
        `No compatible pool was discovered for this pair, and the search did not finish, so absence is not proven.${t.poolsReturned ? ` ${t.poolsReturned} pool(s) were returned but none connects ${t.tokenIn} to ${t.tokenOut}.` : ""}${notes}${multihop}${notProvable}`);
}

/** Direct quotes win when they are within 5% of a WETH/USDC bridge.
 * A thin or mispriced direct pool (RNBW→ETH through a tiny WETH pool) loses
 * to a factory-indexed bridge that pays materially more. Bridges use getter
 * stages only, so this does not start a log sweep. */
const BRIDGE_IMPROVEMENT_BPS = 500n;
/** A getter quote that loses this much versus a 0.1% probe is not the market.
 * Only then do we pay for a Uniswap v4 scan. Healthy pairs stay on getters. */
const SUSPECT_IMPACT_BPS = 500;

async function factoryIndexedPools(source: LiquiditySource, a: Address, b: Address): Promise<readonly Pool[]> {
  const stage = source.directStages?.(a, b)?.find((item) => item.name === "factory-index");
  if (stage) {
    try { return await stage.pools(); } catch (error) {
      if (error instanceof V2QuoteError) throw error;
      return [];
    }
  }
  return source.pools(a, b);
}

/** Best two-hop through WETH or USDC, from the factory-index stage only.
 * Sources without staged discovery are unchanged: a direct quote is not
 * rewritten, and the existing fallback still uses `pools()`. */
async function bestIndexedBridge(source: LiquiditySource, tokenIn: Address, tokenOut: Address, net: bigint): Promise<Leg | null> {
  if (!source.directStages) return null;
  const bridges = [BASE_WETH, BASE_USDC].filter((bridge) => !eq(bridge, tokenIn) && !eq(bridge, tokenOut));
  const stagePools = async (a: Address, b: Address): Promise<readonly Pool[]> => {
    const stage = source.directStages?.(a, b)?.find((item) => item.name === "factory-index");
    if (!stage) return [];
    try { return await stage.pools(); } catch (error) {
      if (error instanceof V2QuoteError) throw error;
      return [];
    }
  };
  const found: Leg[] = [];
  await Promise.all(bridges.map(async (bridge) => {
    try {
      const [left, right] = await Promise.all([
        stagePools(tokenIn, bridge),
        stagePools(bridge, tokenOut),
      ]);
      const hopIns = left.filter((pool) => validPool(pool) && eq(other(pool, tokenIn) ?? "", bridge)).slice(0, 4);
      const hopOuts = right.filter((pool) => validPool(pool) && eq(other(pool, bridge) ?? "", tokenOut)).slice(0, 4);
      const combos: Array<[Pool, Pool]> = [];
      for (const hopIn of hopIns) for (const hopOut of hopOuts) {
        if (combos.length >= 6) break;
        combos.push([hopIn, hopOut]);
      }
      const quotedHops = await Promise.all(combos.map(([hopIn, hopOut]) =>
        quoteLeg(source, [hopIn, hopOut], [tokenIn, bridge, tokenOut], net).catch((error: unknown) => {
          if (error instanceof V2QuoteError && error.code !== "DISCOVERY_UNAVAILABLE") throw error;
          return null;
        })));
      for (const hop of quotedHops) if (hop) found.push(hop);
    } catch (error) {
      if (!(error instanceof V2QuoteError)) throw error;
    }
  }));
  if (!found.length) return null;
  return found.reduce((best, hop) => hop.amountOut > best.amountOut ? hop : best);
}

async function namedStagePools(source: LiquiditySource, name: string, a: Address, b: Address): Promise<readonly Pool[]> {
  const stage = source.directStages?.(a, b)?.find((item) => item.name === name);
  if (!stage) return [];
  try { return await stage.pools(); } catch (error) {
    if (error instanceof V2QuoteError && error.code !== "DISCOVERY_UNAVAILABLE") throw error;
    return [];
  }
}

/** The deep book for many imported Base tokens is a Uniswap v4 pool (RNBW/USDC
 * is ~$145k there; the Aerodrome WETH pool that factory getters find first is ~$50).
 * v4 has no factory getter, so a fast quote must not stop on the thin pool when
 * that pool's own size impact is already >= 5%. */
async function bestV4WhenThin(source: LiquiditySource, tokenIn: Address, tokenOut: Address, net: bigint, legs: readonly Leg[]): Promise<Leg | null> {
  if (!source.directStages) return null;
  const current = legs.reduce((sum, leg) => sum + leg.amountOut, 0n);
  let best: Leg | null = null;
  const consider = (leg: Leg | null) => {
    if (!leg) return;
    const better = current === 0n || leg.amountOut * 10_000n > current * (10_000n + BRIDGE_IMPROVEMENT_BPS);
    if (better && (!best || leg.amountOut > best.amountOut)) best = leg;
  };
  const connects = (pool: Pool, a: Address, b: Address) => validPool(pool) && eq(other(pool, a) ?? "", b);
  const direct = (await namedStagePools(source, "v4-canonical-logs", tokenIn, tokenOut))
    .filter((pool) => connects(pool, tokenIn, tokenOut))
    .slice(0, 4);
  for (const quoted of await Promise.all(direct.map((pool) =>
    quoteLeg(source, [pool], [tokenIn, tokenOut], net).catch(() => null)))) consider(quoted);

  const bridges = [BASE_WETH, BASE_USDC].filter((bridge) => !eq(bridge, tokenIn) && !eq(bridge, tokenOut));
  await Promise.all(bridges.map(async (bridge) => {
    const [left, right] = await Promise.all([
      namedStagePools(source, "v4-canonical-logs", tokenIn, bridge),
      namedStagePools(source, "factory-index", bridge, tokenOut),
    ]);
    const hopIns = left.filter((pool) => connects(pool, tokenIn, bridge)).slice(0, 3);
    const hopOuts = right.filter((pool) => connects(pool, bridge, tokenOut)).slice(0, 3);
    const combos: Array<[Pool, Pool]> = [];
    for (const hopIn of hopIns) for (const hopOut of hopOuts) {
      if (combos.length >= 4) break;
      combos.push([hopIn, hopOut]);
    }
    const quoted = await Promise.all(combos.map(([hopIn, hopOut]) =>
      quoteLeg(source, [hopIn, hopOut], [tokenIn, bridge, tokenOut], net).catch(() => null)));
    for (const hop of quoted) consider(hop);
  }));
  return best;
}

/** Size impact versus a 0.1% probe on the same path. Null when it cannot be measured. */
async function pathPriceImpactBps(source: LiquiditySource, leg: Leg, net: bigint): Promise<number | null> {
  if (leg.pools.length < 1 || leg.amountOut <= 0n || net <= 1000n) return null;
  const probeIn = net / 1000n;
  try {
    const probe = await quoteLeg(source, [...leg.pools], [...leg.tokens], probeIn);
    if (!probe || probe.amountOut <= 0n) return null;
    const fair = probe.amountOut * net / probeIn;
    if (fair <= 0n) return null;
    const worse = fair > leg.amountOut ? fair - leg.amountOut : 0n;
    const bps = Number(worse * 10000n / fair);
    return Number.isFinite(bps) ? Math.min(10_000, Math.max(0, bps)) : null;
  } catch {
    return null;
  }
}
export async function discoverV2Quote(source: LiquiditySource, from: string, to: string, gross: bigint): Promise<V2Quote> {
  const tokenIn = asset(from), tokenOut = asset(to);
  if (eq(tokenIn, tokenOut)) throw new V2QuoteError("INVALID_PAIR", "ETH and WETH are the same asset; select distinct assets");
  const fee = gross * 25n / 10000n, net = gross - fee;
  if (gross <= 0n || fee <= 0n) throw new V2QuoteError("INVALID_AMOUNT", "Sell amount is too small for the mandatory fee");
  const trace: RouteAttemptTrace = {
    tokenIn, tokenOut, gross, net, poolsReturned: 0, rejected: [], candidates: [],
    // Filled in after discovery actually runs: a source reports what IT could
    // establish for this pair, and asking before the call would read stale state.
    negativeProvable: true, notes: [], stages: [],
    multihop: { attempted: false, candidates: 0, note: null },
  };
  /** Splits what one discovery stage returned into dropped-by-validation,
   * dropped-because-it-does-not-connect-this-pair, and actually quotable. Keeping all
   * three is what separates "no pool discovered" from "pool discovered but the executor
   * could not address it" from "pool discovered but the venue refused". */
  const partition = (pools: readonly Pool[]): Pool[] => {
    const quotable: Pool[] = [];
    for (const pool of pools) {
      const rejection = poolRejection(pool);
      if (rejection) { trace.rejected.push({ poolId: pool.id, kind: pool.kind, ...rejection }); continue; }
      if (!eq(other(pool, tokenIn) ?? "", tokenOut)) {
        trace.rejected.push({
          poolId: pool.id, kind: pool.kind, cause: "does-not-connect-pair",
          detail: `pool is ${pool.token0}/${pool.token1}, which does not connect ${tokenIn} to ${tokenOut}`,
        });
        continue;
      }
      quotable.push(pool);
    }
    trace.poolsReturned += pools.length;
    return quotable;
  };
  const recordDiscoveryState = (): void => {
    trace.negativeProvable = source.negativeProvable?.(tokenIn, tokenOut) !== false;
    trace.notes = [...(source.discoveryNotes?.(tokenIn, tokenOut) ?? [])];
  };
  /** A bounded source throws rather than claim a negative it cannot prove. That error
   * must still carry an attribution, or the pair shows up in a coverage report as an
   * unclassified provider failure — the exact ambiguity attribution exists to remove. */
  const attributeDiscoveryThrow = (error: unknown): unknown => {
    if (error instanceof V2QuoteError && !error.attribution) {
      error.attribution = /budget|exceeded|capped|refused|unavailable|could not be established/i.test(error.message)
        ? "BUDGET_EXHAUSTED" : "POOL_NOT_DISCOVERED";
      error.trace = {
        tokenIn, tokenOut, gross, net, poolsReturned: 0, rejected: [], candidates: [],
        negativeProvable: false, notes: [error.message], stages: [...trace.stages],
        multihop: { attempted: false, candidates: 0, note: null },
      };
    }
    return error;
  };
  /** Validates and quotes one pool set, recording every candidate's outcome. */
  const attemptPoolSet = async (pools: readonly Pool[]): Promise<{ quotable: Pool[]; legs: Leg[] }> => {
    const quotable = partition(pools);
    const attempts = await Promise.all(quotable.map(pool => attemptCandidate(source, pool, tokenIn, tokenOut, net)));
    for (let i = 0; i < quotable.length; i++) {
      trace.candidates.push({
        poolId: quotable[i].id, kind: quotable[i].kind,
        hooks: quotable[i].kind === 7 ? quotable[i].v4Key?.hooks ?? null : null,
        outcome: attempts[i].outcome,
      });
    }
    return { quotable, legs: attempts.map(a => a.leg).filter((l): l is Leg => l !== null) };
  };

  let direct: Pool[] = [];
  let quoted: Leg[] = [];
  let stageFailure: unknown = null;
  const stages = source.directStages?.(tokenIn, tokenOut);
  if (stages && stages.length > 0) {
    // ORDERED. Getter-backed venues are a handful of eth_calls; the v4 Initialize
    // search is eth_getLogs. A pair a factory can price does not scan v4 up front.
    // If that getter quote later shows >= 5% size impact, bestV4WhenThin compares
    // the v4 book — that is how a thin RNBW/WETH pool loses to the liquid v4 USDC pool.
    for (const stage of stages) {
      let pools: readonly Pool[];
      let complete = false;
      try {
        pools = await stage.pools();
        complete = stage.complete();
      } catch (error) {
        // A stage that cannot run is recorded and the search continues: a later stage may
        // still answer. If none does, attribution names every stage that failed.
        trace.stages.push({
          name: stage.name, poolsReturned: 0, quotable: 0, complete: false,
          note: error instanceof Error ? error.message : String(error),
        });
        if (!(error instanceof V2QuoteError)) throw error;
        if (stageFailure === null) stageFailure = error;
        continue;
      }
      const attempted = await attemptPoolSet(pools);
      trace.stages.push({ name: stage.name, poolsReturned: pools.length, quotable: attempted.quotable.length, complete });
      direct = attempted.quotable;
      quoted = attempted.legs;
      recordDiscoveryState();
      if (quoted.length) break;
    }
    // Nothing quotable and a stage could not finish: that failure decides the verdict,
    // because it is why "no pool" cannot be proven.
    if (!quoted.length && stageFailure !== null && trace.candidates.length === 0) throw attributeDiscoveryThrow(stageFailure);
  } else {
    // Single-stage source: hints if offered, then the complete canonical answer.
    if (source.hints) {
      const hinted = await attemptPoolSet(await source.hints(tokenIn, tokenOut));
      trace.stages.push({ name: "hints", poolsReturned: trace.poolsReturned, quotable: hinted.quotable.length, complete: false });
      direct = hinted.quotable;
      quoted = hinted.legs;
      recordDiscoveryState();
    }
    if (!quoted.length) {
      // Hints cannot prove absence. Complete canonical discovery is mandatory before
      // allowing multi-hop or returning LIQUIDITY_UNAVAILABLE.
      let pools: readonly Pool[];
      try {
        pools = await source.pools(tokenIn, tokenOut);
      } catch (error) {
        throw attributeDiscoveryThrow(error);
      }
      const attempted = await attemptPoolSet(pools);
      direct = attempted.quotable;
      quoted = attempted.legs;
      recordDiscoveryState();
    }
  }
  let legs: readonly Leg[] = [];
  if (quoted.length) {
    const best = quoted.reduce((a, b) => b.amountOut > a.amountOut ? b : a);
    legs = [best];
    // Optimize direct venue splits on net allocation, never fee each leg. No
    // repeated pool: quoter calls are independent; shared liquidity is not additive.
    // Quoted in parallel — the previous nested awaits were most of a slow quote.
    const splits: Array<Promise<readonly Leg[] | null>> = [];
    for (let i = 0; i < direct.length; i++) for (let j = i + 1; j < direct.length && j < i + 3; j++) {
      if (direct[i].id === direct[j].id) continue;
      for (const weight of [25n, 50n, 75n]) {
        const first = net * weight / 100n;
        if (!first || first === net) continue;
        const leftPool = direct[i];
        const rightPool = direct[j];
        splits.push((async () => {
          const [a, b] = await Promise.all([
            quoteLeg(source, [leftPool], [tokenIn, tokenOut], first),
            quoteLeg(source, [rightPool], [tokenIn, tokenOut], net - first),
          ]);
          return a && b ? [a, b] as const : null;
        })());
      }
    }
    const splitResults = await Promise.all(splits);
    for (const pair of splitResults) {
      if (pair && pair[0].amountOut + pair[1].amountOut > legs.reduce((s, l) => s + l.amountOut, 0n)) legs = pair;
    }
  } else {
    const candidates: Leg[] = [];
    trace.multihop.attempted = true;
    // Major-asset bridges only. Pair lookups use factory getters, not a chain
    // log sweep, so a token that pools against WETH or USDC can still be quoted
    // when neighbour enumeration is disabled. Fee stays on gross, once.
    const bridges = [BASE_WETH, BASE_USDC].filter((bridge) => !eq(bridge, tokenIn) && !eq(bridge, tokenOut));
    for (const bridge of bridges) {
      try {
        const [leftAll, rightAll] = await Promise.all([
          factoryIndexedPools(source, tokenIn, bridge),
          factoryIndexedPools(source, bridge, tokenOut),
        ]);
        const left = leftAll.filter((pool) => validPool(pool) && eq(other(pool, tokenIn) ?? "", bridge));
        const right = rightAll.filter((pool) => validPool(pool) && eq(other(pool, bridge) ?? "", tokenOut));
        let combinations = 0;
        const hops: Array<Promise<Leg | null>> = [];
        for (const hopIn of left) for (const hopOut of right) {
          if (combinations >= 6) break;
          combinations += 1;
          hops.push(quoteLeg(source, [hopIn, hopOut], [tokenIn, bridge, tokenOut], net).catch(() => null));
        }
        for (const quotedHop of await Promise.all(hops)) if (quotedHop) candidates.push(quotedHop);
      } catch (error) {
        if (!(error instanceof V2QuoteError)) throw error;
        trace.multihop.note = error.message;
      }
    }
    try {
    // Meet in the middle: enumerate liquidity neighbors of the requested
    // endpoints only. Never enumerate every WETH/USDC pool as a bridge catalog.
    const first = (await source.pools(tokenIn)).filter(validPool);
    const last = (await source.pools(tokenOut)).filter(validPool);
    for (const a of first) {
      const x = other(a, tokenIn);
      if (!x || eq(x, tokenOut) || eq(x, tokenIn)) continue;
      for (const b of last) {
        const y = other(b, tokenOut);
        if (!y || eq(y, tokenIn) || eq(y, tokenOut)) continue;
        if (eq(x, y)) {
          const q = await quoteLeg(source, [a, b], [tokenIn, x, tokenOut], net);
          if (q) candidates.push(q);
        } else {
          for (const middle of await source.pools(x, y)) {
            if (!validPool(middle) || !eq(other(middle, x) ?? "", y)) continue;
            const q = await quoteLeg(source, [a, middle, b], [tokenIn, x, y, tokenOut], net);
            if (q) candidates.push(q);
          }
        }
      }
    }
    } catch (error) {
      // Neighbour enumeration can be unavailable when the log sweep is off.
      // A WETH/USDC bridge found above is still a real route, so do not drop it.
      if (!(error instanceof V2QuoteError)) throw error;
      trace.multihop.note = error.message;
    }
    candidates.sort((a, b) => a.amountOut === b.amountOut ? a.pools.length - b.pools.length : a.amountOut > b.amountOut ? -1 : 1);
    if (candidates.length) legs = [candidates[0]];
    trace.multihop.candidates = candidates.length;
  }
  // A direct pool that quotes is not automatically the fair price. Compare it
  // with a WETH/USDC factory-index bridge and keep the bridge only when it
  // pays more than 5% extra — enough to drop a thin RNBW/WETH pool, not
  // enough to rewrite a healthy direct pair for a rounding difference.
  try {
    const bridged = await bestIndexedBridge(source, tokenIn, tokenOut, net);
    const current = legs.reduce((sum, leg) => sum + leg.amountOut, 0n);
    if (bridged && (current === 0n || bridged.amountOut * 10_000n > current * (10_000n + BRIDGE_IMPROVEMENT_BPS))) {
      legs = [bridged];
      trace.multihop.attempted = true;
      trace.multihop.candidates = Math.max(trace.multihop.candidates, 1);
    }
  } catch (error) {
    if (!(error instanceof V2QuoteError)) throw error;
    if (!trace.multihop.note) trace.multihop.note = error.message;
  }
  if (!legs.length) throw attributeRouteFailure(trace);
  let priceImpactBps = legs.length === 1 ? await pathPriceImpactBps(source, legs[0], net) : null;
  if (priceImpactBps != null && priceImpactBps >= SUSPECT_IMPACT_BPS) {
    try {
      const rescued = await bestV4WhenThin(source, tokenIn, tokenOut, net, legs);
      if (rescued) {
        legs = [rescued];
        trace.multihop.attempted = true;
        trace.multihop.candidates = Math.max(trace.multihop.candidates, 1);
        priceImpactBps = await pathPriceImpactBps(source, rescued, net);
      }
    } catch (error) {
      if (!(error instanceof V2QuoteError)) throw error;
      if (!trace.multihop.note) trace.multihop.note = error.message;
    }
  }
  const amountOut = legs.reduce((s, l) => s + l.amountOut, 0n);
  const result: V2Quote = { tokenIn, tokenOut, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net, amountOut, legs, priceImpactBps };
  validateV2Quote(result); return result;
}
export interface V2Snapshot { number: bigint; hash: Hex }
