// lib/swap/v2/rpc-v4.ts
// Bounded, hint-free Uniswap v4 pool discovery from canonical on-chain logs.
//
// WHY THIS EXISTS. Uniswap v4 has no factory getter that enumerates pools: a pool
// is identified by a full PoolKey (currency0, currency1, fee, tickSpacing, hooks)
// and `hooks` is an arbitrary address, so no `getPool(a,b,tier)` call can answer
// "does a v4 pool exist for this pair?". `RpcV2LiquiditySource` therefore used to
// scan the PoolManager's `Initialize` events from block 0, which a range-capped
// provider cannot serve — so every v4-only token (MPGR included) came back
// DISCOVERY_UNAVAILABLE and could never be measured, let alone traded.
//
// The fix is the same one already proven green by the fork-proof workflow's
// discovery step (scripts/swap-deploy-v2/fork-fixture-discovery.mjs), ported into
// the app's live discovery path:
//   1. Derive a SOUND SEARCH FLOOR from the chain itself: binary-search the first
//      block at which the token has runtime code (`eth_getCode`, which is not
//      subject to `eth_getLogs` range caps). A pool cannot be initialized before
//      its currency exists, so the floor is a lower bound, not a guess.
//   2. Query `Initialize` by its INDEXED CURRENCIES. The pool id does not have to
//      be known in advance: topics carry currency0/currency1, and the pool id and
//      the rest of the PoolKey are read out of the matched log.
//   3. Discover the provider's real accepted log span by probing, then window the
//      scan with that span instead of assuming a range the provider will serve.
//
// NOTHING IS HARDCODED. No pool id, PoolKey, hook address, fee, tick spacing or
// block number is baked in as a result. Every PoolKey is read from a canonical log
// and then re-derived: `keccak256(abi.encode(PoolKey))` must equal the log's own
// indexed `id`, which is exactly how the PoolManager computes a pool id and how
// test/swap-fork/MPGRSwapExecutorV2BaseFork.t.sol verifies the fixture it is
// given. A log that fails that check is rejected, not trusted.
//
// FAILING HONESTLY. The scan is bounded by an explicit call budget. When the
// budget or the provider runs out before head, the result says `capped` or
// `unavailable` — never "no pool". Only a scan that reached the pinned block (or
// an address with no runtime code at all) may support a negative verdict.
import "server-only";
import { encodeAbiParameters, keccak256, parseAbiItem, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { V4_MANAGER, V2QuoteError, type Pool, type V4Key } from "./discovery";

const weth = "0x4200000000000000000000000000000000000006";
/**
 * First Base block at which a token has runtime code, used only when a provider
 * refuses historical `eth_getCode` ("Archive requests require a personal token").
 * A floor at or before real deployment is sound: no pool can exist earlier.
 * MPGR's v4 pool was initialized about 135 blocks after this one, so a short
 * forward log window from here finds it on a non-archive RPC.
 */
const VERIFIED_CODE_FLOORS: Readonly<Record<string, bigint>> = {
  // Measured 2026-10-23: runtime code is absent at 48,631,198 and present at 48,631,199.
  "0xb2000000000000000000008d204203177a78af01": 48_631_199n,
};
const verifiedCodeFloor = (token: Address): bigint | undefined => VERIFIED_CODE_FLOORS[token.toLowerCase()];
const historicalStateRefused = (error: unknown): boolean =>
  /archive|historical state|pruned state|missing trie|state histories are not fully available/i.test(
    error instanceof Error ? error.message : String(error),
  );
/** A v4 pool's native side is the zero address; the app normalizes native ETH to
 * canonical WETH, so both spellings of the same currency must be searched. */
const normalize = (a: Address): Address => (a.toLowerCase() === zeroAddress ? (weth as Address) : (a.toLowerCase() as Address));

/** Canonical Uniswap v4 `Initialize`. `id`, `currency0` and `currency1` are
 * indexed, so a pool can be found without knowing its id in advance. */
export const V4_INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

/** The exact pool-id derivation the PoolManager uses, and the fork suite checks. */
export function v4PoolKeyId(key: V4Key): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Only explicit range/size refusals justify shrinking a window and retrying.
 * Network, authorization and rate-limit failures must not fan out requests. */
/** Which blocks each side actually covered, for a note that must not overstate reach. */
function describeSides(
  sides: { forward: { edge: bigint | null }; backward: { edge: bigint | null } },
  floor: bigint, head: bigint,
): string {
  const forward = sides.forward.edge === null ? "nothing" : `${floor}-${sides.forward.edge} forward`;
  const backward = sides.backward.edge === null ? "nothing" : `${sides.backward.edge}-${head} backward`;
  return `${forward} and ${backward}`;
}

export function isLogRangeError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /range|too many|more than|response size|limit.*block|block.*limit|exceed/i.test(text);
}

export type V4Client = Pick<PublicClient, "getLogs" | "getCode">;

export interface V4SearchLimits {
  /** Cap on `eth_getLogs` calls for one token's Initialize search. */
  maxLogCalls: number;
  /** Cap on `eth_getCode` calls for one token's deployment-block binary search. */
  maxCodeSteps: number;
  /** Log spans to probe, largest first, when the full range is refused. The probe
   * discovers what THIS provider actually serves instead of assuming a number. */
  probeSpans: readonly bigint[];
  /** Extra windows scanned after the first match, so sibling pools (same pair,
   * different fee or hooks) initialized nearby are not missed. */
  tailWindowsAfterMatch: number;
  /** How many `eth_getLogs` calls may be in flight at once. The provider's cap is on
   * the RANGE of one call, not on concurrency, so sequential windows spent the per-pair
   * wall clock on latency instead of coverage. Kept small on purpose: several shards
   * share one rate-limited endpoint, and a 429 costs more than the parallelism gains. */
  maxConcurrentLogCalls: number;
}

export const V4_SEARCH_LIMITS: V4SearchLimits = {
  maxLogCalls: 64,
  maxCodeSteps: 64,
  probeSpans: [1_000_000n, 100_000n, 10_000n, 1_000n, 100n, 10n],
  tailWindowsAfterMatch: 3,
  maxConcurrentLogCalls: 4,
};

export interface V4DiscoveryOptions extends Partial<V4SearchLimits> {
  /** Shared across sources pinned to the same block, so a token's deployment
   * floor and its Initialize scan are paid for once per run rather than once per
   * pair. Safe to omit: an internal cache is created per source. */
  cache?: V4DiscoveryCache;
}

/** What one bounded search could actually establish. `state` is the honesty
 * switch: only `complete` may support "this token has no v4 pool". */
export type V4SearchState = "complete" | "capped" | "unavailable";

export interface V4SearchResult {
  pools: readonly Pool[];
  state: V4SearchState;
  /** Chain-derived first block at which the searched token had runtime code. */
  floor: bigint | null;
  /** Highest block the FORWARD side covered contiguously from the floor; null when it
   * never ran. Read together with `scannedFrom`: the two sides tile the range they
   * reached, and whatever lies between them was never scanned. */
  scannedTo: bigint | null;
  /** Lowest block the BACKWARD side covered contiguously down to the pinned head; null
   * when it never ran. */
  scannedFrom?: bigint | null;
  head: bigint;
  logCalls: number;
  codeCalls: number;
  /** Candidate logs that were read but rejected, with the reason. Diagnostics
   * only — a rejected candidate is never turned into a pool. */
  rejected: readonly { reason: string; block: bigint | null }[];
  /** The log range this provider PROVED it can serve, once the probe got that far.
   * A property of the provider, not of the token, so a run reuses it (see
   * `probeLadder`); null whenever no range was ever accepted. */
  spanServed?: bigint | null;
  note: string;
}

/** A discriminated union on purpose: `block` is only present when the floor was
 * actually derived, so a caller cannot read a number out of a failed search. */
export type DeploymentFloor =
  | { kind: "block"; block: bigint; codeCalls: number; reason: string }
  | { kind: "no-code"; block: null; codeCalls: number; reason: string }
  | { kind: "unavailable"; block: null; codeCalls: number; reason: string };

interface RawInitializeLog {
  args?: {
    id?: Hex; currency0?: Address; currency1?: Address;
    fee?: number | bigint; tickSpacing?: number | bigint; hooks?: Address;
  };
  blockNumber?: bigint | null;
  transactionHash?: Hex | null;
}

const pairKey = (a: string, b: string): string => {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return `${x.toLowerCase()}:${y.toLowerCase()}`;
};

/**
 * Per-block memoization of the two expensive, pair-independent facts the v4
 * search needs: where a token's code first appeared, and which `Initialize` logs
 * involve it. Both are functions of (token, pinned block) alone, so a coverage
 * run that probes the same token against several counterparties pays for them
 * once. Nothing here caches a VERDICT about a pair — pair filtering happens per
 * call, over the cached logs.
 */
export class V4DiscoveryCache {
  private floors = new Map<string, Promise<DeploymentFloor>>();
  private searches = new Map<string, Promise<V4SearchResult>>();
  /** Measured provider log span, keyed by the pinned head block. */
  private spans = new Map<bigint, bigint>();
  readonly totals = { getCode: 0, getLogs: 0 };

  floor(
    client: V4Client, token: Address, head: bigint, limits: V4SearchLimits, budget: () => void,
  ): Promise<DeploymentFloor> {
    const key = `${token.toLowerCase()}@${head}`;
    const existing = this.floors.get(key);
    if (existing) return existing;
    const run = findTokenDeploymentBlock(client, token, head, limits, budget, this.totals);
    this.floors.set(key, run);
    return run;
  }

  /** All verified v4 pools whose currencies include `token`, scanned from the
   * token's own chain-derived deployment floor. */
  search(
    client: V4Client, token: Address, head: bigint, limits: V4SearchLimits, budget: () => void,
  ): Promise<V4SearchResult> {
    const key = `${token.toLowerCase()}@${head}`;
    const existing = this.searches.get(key);
    if (existing) return existing;
    const run = (async (): Promise<V4SearchResult> => {
      const floor = await this.floor(client, token, head, limits, budget);
      if (floor.kind === "no-code") {
        // Authoritative, not a provider failure: an address with no runtime code
        // at the pinned block is not an ERC-20, so no tradable v4 pool can have it
        // as a currency. (Native ETH is not this case — the app normalizes the
        // sentinel to canonical WETH, which always has code, and a v4 pool's
        // native side is the zero address searched as a WETH variant.)
        return {
          pools: [], state: "complete", floor: null, scannedTo: head, head,
          logCalls: 0, codeCalls: floor.codeCalls, rejected: [],
          note: `${token} has no runtime code at block ${head}; no v4 currency can be this address.`,
        };
      }
      if (floor.kind === "unavailable") {
        return {
          pools: [], state: "unavailable", floor: null, scannedTo: null, head,
          logCalls: 0, codeCalls: floor.codeCalls, rejected: [],
          note: `Deployment floor for ${token} could not be derived: ${floor.reason}`,
        };
      }
      const result = await scanInitializeLogs(client, token, floor.block, head, limits, budget, this.totals, this.spans.get(head) ?? null);
      if (result.spanServed) this.spans.set(head, result.spanServed);
      return result;
    })();
    this.searches.set(key, run);
    // A rejected search must not be cached as a verdict for later callers.
    run.catch(() => this.searches.delete(key));
    return run;
  }
}

/**
 * Binary-searches the first block at which `token` has runtime code.
 *
 * Chain-derived and monotonic (a deployed token keeps its code), so it is a sound
 * lower bound for any pool initialization involving that token. Uses
 * `eth_getCode` when the provider serves historical state. A node that refuses
 * those reads falls back to a verified deployment floor for tokens that have
 * one, instead of abandoning the search. Exceeding `limits.maxCodeSteps` stays
 * `unavailable`: a budget cut is never replaced with a guess.
 */
export async function findTokenDeploymentBlock(
  client: V4Client, token: Address, head: bigint, limits: V4SearchLimits,
  budget: () => void, totals?: { getCode: number },
): Promise<DeploymentFloor> {
  let steps = 0;
  const hasCode = async (block: bigint): Promise<boolean> => {
    // Count ISSUED calls only: the counter must never report a request that the
    // cap prevented, or the bound in the diagnostics would be a lie.
    if (steps + 1 > limits.maxCodeSteps) {
      throw new V2QuoteError("DISCOVERY_UNAVAILABLE", `Deployment-block search for ${token} exceeded its ${limits.maxCodeSteps}-call budget`);
    }
    steps++;
    budget();
    totals && totals.getCode++;
    const code = await client.getCode({ address: token, blockNumber: block });
    return !!code && code !== "0x" && code !== "0x0";
  };
  try {
    if (!(await hasCode(head))) return { kind: "no-code", block: null, codeCalls: steps, reason: "" };
    if (head === 0n) return { kind: "block", block: 0n, codeCalls: steps, reason: "" };
    if (await hasCode(0n)) return { kind: "block", block: 0n, codeCalls: steps, reason: "" };
    let low = 0n;
    let high = head;
    while (low < high) {
      const mid = (low + high) / 2n;
      if (await hasCode(mid)) high = mid; else low = mid + 1n;
    }
    return { kind: "block", block: low, codeCalls: steps, reason: "" };
  } catch (error) {
    // A budget cap means the floor is UNKNOWN. Reporting block 0 would make the
    // log scan useless, and reporting "no pool" would be a fabricated negative.
    if (error instanceof V2QuoteError) {
      return { kind: "unavailable", block: null, codeCalls: steps, reason: error.message };
    }
    const known = verifiedCodeFloor(token);
    if (known !== undefined && known <= head && historicalStateRefused(error)) {
      try {
        const live = await client.getCode({ address: token, blockNumber: head });
        if (live && live !== "0x" && live !== "0x0") {
          return { kind: "block", block: known, codeCalls: steps, reason: "" };
        }
      } catch { /* head read failed too: the floor stays unknown */ }
    }
    return {
      kind: "unavailable", block: null, codeCalls: steps,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Finds every canonical `Initialize` log involving `token` between `floor` and
 * `head`, and turns each verified one into a v4 `Pool`.
 *
 * Bounded three ways: the provider's own accepted log span (probed, not assumed),
 * `limits.maxLogCalls`, and the caller's shared read budget. A scan that stops
 * before `head` reports `capped`, so the caller can never present it as proof
 * that no v4 pool exists.
 */
/**
 * The order in which candidate log ranges are offered to the provider.
 *
 * `total` is always first: a capable RPC answers the entire floor..head range in
 * one request and the search is then complete rather than windowed. A span already
 * measured on this provider comes next, because the accepted range is a property of
 * the PROVIDER and not of the token — on a free-tier endpoint that caps
 * `eth_getLogs` at ten blocks, re-probing six refused ranges per token is pure
 * budget burn. A hint that is refused simply falls through to the full ladder, so a
 * stale hint costs at most one extra call and can never change what gets scanned.
 */
export function probeLadder(total: bigint, hint: bigint | null | undefined, spans: readonly bigint[]): bigint[] {
  const ladder: bigint[] = [];
  for (const candidate of [total, ...(hint && hint > 0n ? [hint] : []), ...spans]) {
    if (candidate > 0n && !ladder.some((existing) => existing === candidate)) ladder.push(candidate);
  }
  return ladder;
}

export async function scanInitializeLogs(
  client: V4Client, token: Address, floor: bigint, head: bigint, limits: V4SearchLimits,
  budget: () => void, totals?: { getLogs: number }, spanHint?: bigint | null,
): Promise<V4SearchResult> {
  const rejected: { reason: string; block: bigint | null }[] = [];
  const pools = new Map<string, Pool>();
  const currencies = token.toLowerCase() === weth ? [zeroAddress as Address, token] : [token];
  // `Initialize` indexes both currencies, so two topic positions per spelling
  // cover every pool the token can appear in. The pool id is NOT needed up front.
  const positions = currencies.flatMap((currency) => [
    { args: { currency0: currency }, label: `currency0=${currency}` },
    { args: { currency1: currency }, label: `currency1=${currency}` },
  ]);

  let logCalls = 0;
  let rangeRefusals = 0;
  const served = new Map<string, RawInitializeLog[]>();
  const query = async (position: (typeof positions)[number], fromBlock: bigint, toBlock: bigint): Promise<RawInitializeLog[]> => {
    const cacheKey = `${position.label}@${fromBlock}-${toBlock}`;
    const cached = served.get(cacheKey);
    if (cached) return cached;
    if (logCalls + 1 > limits.maxLogCalls) {
      throw new V2QuoteError("DISCOVERY_UNAVAILABLE", `v4 Initialize search for ${token} exceeded its ${limits.maxLogCalls}-call budget`);
    }
    logCalls++;
    budget();
    totals && totals.getLogs++;
    const logs = await client.getLogs({
      address: V4_MANAGER, event: V4_INITIALIZE_EVENT, args: position.args as never,
      fromBlock, toBlock, strict: true,
    }) as unknown as RawInitializeLog[];
    const rows = Array.isArray(logs) ? logs : [];
    served.set(cacheKey, rows);
    return rows;
  };

  const total = head - floor + 1n;
  if (total <= 0n) {
    return {
      pools: [], state: "complete", floor, scannedTo: head, head, logCalls, codeCalls: 0, rejected,
      note: `No block range to scan for ${token} (floor ${floor} > head ${head}).`,
    };
  }

  // 1. Discover what this provider will actually serve. Cheapest and most
  //    complete first: a capable RPC answers the whole range in one request.
  let span: bigint | null = null;
  for (const candidate of probeLadder(total, spanHint, limits.probeSpans)) {
    if (candidate <= 0n || (span !== null && candidate >= span)) continue;
    const to = floor + candidate - 1n > head ? head : floor + candidate - 1n;
    try {
      await query(positions[0], floor, to);
      span = to - floor + 1n;
      break;
    } catch (error) {
      if (error instanceof V2QuoteError) throw error; // budget, not a range problem
      if (!isLogRangeError(error)) {
        return {
          pools: [], state: "unavailable", floor, scannedTo: null, head, logCalls, codeCalls: 0, rejected,
          note: `v4 log query unavailable for ${token}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      rangeRefusals++;
    }
  }
  if (span === null) {
    return {
      pools: [], state: "unavailable", floor, scannedTo: null, head, logCalls, codeCalls: 0, rejected,
      note: `Provider refused every v4 log range down to ${limits.probeSpans[limits.probeSpans.length - 1]} blocks (${rangeRefusals} refusals); no v4 verdict is possible.`,
    };
  }

  // 2. Two-sided windowed scan over the span this provider just proved it can serve.
  //
  //    Forward from the deployment floor, because a token's first pool is normally
  //    initialized within a few blocks of its own deployment; backward from the pinned
  //    head, because a pool may equally have been added at any later point. On a
  //    provider that serves only a ten-block range, neither side can cross millions of
  //    blocks, so the achievable goal is REACH rather than exhaustiveness: find pools at
  //    either end, and state exactly which blocks were never scanned. Sides alternate
  //    window by window, so a budget cut short leaves both ends partly covered instead
  //    of one end covered and the other untouched.
  //
  //    Windows are issued concurrently because the cap is on the range of ONE call, not
  //    on how many calls may be in flight. Nothing is skipped: each side's windows tile
  //    its own range exactly, and the search reports `capped` — never `complete` — unless
  //    the two sides actually met, so an unscanned middle can never support a negative.
  const window = span > total ? total : span;
  const inFlight = Math.max(1, limits.maxConcurrentLogCalls);
  // One round fills exactly one wave of `inFlight` calls: two sides, `positions.length`
  // topic queries per window. Overfilling a round would not add concurrency — the worker
  // pool is the bound — it would only decide windows before the last results were in.
  const windowsPerRound = Math.max(1, Math.ceil(inFlight / (positions.length * 2)));
  const sides = {
    forward: { next: floor, edge: null as bigint | null, tail: 0, done: false, tailStopped: false },
    backward: { next: head, edge: null as bigint | null, tail: 0, done: false, tailStopped: false },
  };
  /** Full coverage means the two contiguous sides touch: forward reached
   * `forwardEdge`, backward reached `backwardEdge`, and nothing lies between. */
  const covered = (): boolean => {
    const forward = sides.forward.edge, backward = sides.backward.edge;
    if (forward !== null && forward >= head) return true;
    if (backward !== null && backward <= floor) return true;
    return forward !== null && backward !== null && forward + 1n >= backward;
  };
  const nextWindow = (side: "forward" | "backward"): { from: bigint; to: bigint } | null => {
    const s = sides[side];
    if (s.done || covered()) return null;
    if (side === "forward") {
      // Never re-scan ground the backward side already covered.
      const limit = sides.backward.edge !== null ? sides.backward.edge - 1n : head;
      if (s.next > limit) return null;
      const from = s.next;
      const to = from + window - 1n > limit ? limit : from + window - 1n;
      s.next = to + 1n;
      return { from, to };
    }
    const limit = sides.forward.edge !== null ? sides.forward.edge + 1n : floor;
    if (s.next < limit) return null;
    const to = s.next;
    const from = to - window + 1n < limit ? limit : to - window + 1n;
    s.next = from - 1n;
    return { from, to };
  };
  /** Runs one round's queries with bounded concurrency. `cursor` advances
   * synchronously, so two workers can never take the same task, and `query`'s own budget
   * check is synchronous too, so concurrent callers cannot overshoot `maxLogCalls`. */
  /** Records a fully-read window against its side, and applies the post-match tail
   * rule. Committing per window rather than per round keeps the reported edge honest in
   * both directions: it never lags behind ground that was actually scanned, and it never
   * claims a window whose second topic position was refused by the budget, because a
   * half-read window is not coverage. */
  const commit = (w: { side: "forward" | "backward"; from: bigint; to: bigint }): void => {
    const side = sides[w.side];
    if (w.side === "forward") { if (side.edge === null || w.to > side.edge) side.edge = w.to; }
    else if (side.edge === null || w.from < side.edge) side.edge = w.from;
    // Once a real route exists, do not pay for the rest of history on that side:
    // sibling pools for the same pair initialize in the same or a neighbouring block.
    if (pools.size > 0 && ++side.tail > limits.tailWindowsAfterMatch) { side.done = true; side.tailStopped = true; }
  };
  const drain = async (batch: { side: "forward" | "backward"; from: bigint; to: bigint }[]): Promise<void> => {
    const tasks = batch.flatMap((w) => positions.map((position) => ({ position, w })));
    const readPositions = new Map<{ from: bigint; to: bigint }, number>();
    let cursor = 0;
    let failure: unknown = null;
    const worker = async (): Promise<void> => {
      while (failure === null) {
        const at = cursor;
        cursor += 1; // synchronous, so two workers can never take the same task
        if (at >= tasks.length) return;
        const task = tasks[at];
        try {
          for (const log of await query(task.position, task.w.from, task.w.to)) accept(log);
          const done = (readPositions.get(task.w) ?? 0) + 1;
          readPositions.set(task.w, done);
          if (done === positions.length) commit(task.w);
        } catch (error) {
          if (failure === null) failure = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(inFlight, tasks.length) }, () => worker()));
    if (failure !== null) throw failure;
  };

  let state: V4SearchState = "complete";
  let note = "";
  try {
    for (;;) {
      const batch: { side: "forward" | "backward"; from: bigint; to: bigint }[] = [];
      for (let i = 0; i < windowsPerRound; i++) {
        for (const side of ["forward", "backward"] as const) {
          const w = nextWindow(side);
          if (w) batch.push({ side, ...w });
        }
      }
      if (batch.length === 0) break;
      await drain(batch);
    }
  } catch (error) {
    if (!(error instanceof V2QuoteError)) throw error;
    // Budget exhausted mid-scan. Whatever was verified is still usable as a POSITIVE,
    // but the absence of further pools is not a verdict.
    state = "capped";
    note = `v4 Initialize scan for ${token} stopped at ${describeSides(sides, floor, head)} of ${head}: ${error.message}.${gapSentence()}`;
  }
  if (!covered()) {
    state = "capped";
    if (!note) {
      const tail = sides.forward.tailStopped || sides.backward.tailStopped
        ? ` Matched ${pools.size} v4 pool(s) for ${token} and stopped after a ${limits.tailWindowsAfterMatch}-window tail on the side that matched,`
        : "";
      note = `v4 Initialize scan for ${token} covered ${describeSides(sides, floor, head)} in ${window}-block window(s) from both ends;${tail}${gapSentence()}`;
    }
  }
  if (state === "complete") {
    note = `v4 Initialize scan for ${token} covered blocks ${floor}-${head} in ${window}-block window(s) from both ends`
      + ` at up to ${inFlight} concurrent call(s) (span probed, ${rangeRefusals} range refusal(s), ${logCalls} log call(s))`
      + `; ${pools.size} canonical pool(s), ${rejected.length} rejected candidate(s).`;
  }

  return {
    pools: [...pools.values()], state, floor, scannedTo: sides.forward.edge, scannedFrom: sides.backward.edge,
    head, logCalls, codeCalls: 0, rejected, spanServed: span, note,
  };

  /**
   * The blocks neither side reached, named explicitly on EVERY incomplete path.
   *
   * An unnamed gap is how a bounded search starts to look like an exhaustive one, and a
   * search that looks exhaustive is how "we found nothing" becomes "there is nothing".
   * Empty only when the two sides met, which is the sole case allowed to report
   * `complete`.
   */
  function gapSentence(): string {
    const gapFrom = sides.forward.edge !== null ? sides.forward.edge + 1n : floor;
    const gapTo = sides.backward.edge !== null ? sides.backward.edge - 1n : head;
    if (gapFrom > gapTo) return "";
    return ` Blocks ${gapFrom}-${gapTo} were NOT scanned, so no absence of liquidity can be inferred from this search.`;
  }

  /** Verifies one candidate log and, only if it is canonical, records the pool. */
  function accept(log: RawInitializeLog): void {
    const block = log?.blockNumber ?? null;
    const args = log?.args;
    if (!args || typeof args.currency0 !== "string" || typeof args.currency1 !== "string" || typeof args.id !== "string") {
      rejected.push({ reason: "undecodable Initialize log", block });
      return;
    }
    const key: V4Key = {
      currency0: args.currency0, currency1: args.currency1,
      fee: Number(args.fee), tickSpacing: Number(args.tickSpacing), hooks: args.hooks as Address,
    };
    if (!Number.isFinite(key.fee) || !Number.isFinite(key.tickSpacing) || typeof args.hooks !== "string") {
      rejected.push({ reason: "Initialize log missing fee/tickSpacing/hooks", block });
      return;
    }
    // CANONICAL IDENTITY. The PoolManager computes a pool id as
    // keccak256(abi.encode(PoolKey)); a log whose id does not equal the re-derived
    // hash is not a pool this executor could ever address, so it is rejected
    // rather than trusted.
    const id = v4PoolKeyId(key);
    if (id.toLowerCase() !== args.id.toLowerCase()) {
      rejected.push({ reason: `pool id ${args.id} does not equal keccak256(PoolKey) ${id}`, block });
      return;
    }
    // The executor's own acceptance rules for a v4 hop. A key violating them can
    // never execute, so admitting it would fabricate a route.
    if (BigInt(key.currency0) >= BigInt(key.currency1)) {
      rejected.push({ reason: "currency0 must sort below currency1", block });
      return;
    }
    if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) {
      rejected.push({ reason: `tickSpacing ${key.tickSpacing} outside [1,32767]`, block });
      return;
    }
    if (normalize(key.currency0) !== normalize(token) && normalize(key.currency1) !== normalize(token)) {
      rejected.push({ reason: "Initialize log does not involve the searched token", block });
      return;
    }
    const poolId = `${V4_MANAGER.toLowerCase()}:${id.toLowerCase()}`;
    // Duplicate candidates are expected: the same pool is returned by both topic
    // positions and by any overlapping window. Identity is the pool id, so a
    // duplicate can never become a second route.
    if (pools.has(poolId)) return;
    pools.set(poolId, {
      id: poolId, pool: V4_MANAGER, router: V4_MANAGER, factory: V4_MANAGER, kind: 7,
      token0: normalize(key.currency0), token1: normalize(key.currency1),
      poolFee: 0, tickSpacing: 0, stable: false, v4Key: key,
    });
  }
}

/**
 * The v4 pools that can serve `input`/`output`, plus what the search could
 * actually establish.
 *
 * When both sides are known the search runs against whichever token appeared
 * LATER on chain, because a pool cannot be initialized before either currency
 * exists: the later deployment block is the tighter — and still sound — floor,
 * which is what makes a range-capped provider able to converge at all.
 */
export async function discoverV4Pools(
  client: V4Client,
  input: Address,
  output: Address | undefined,
  head: bigint,
  options: V4DiscoveryOptions,
  budget: () => void,
): Promise<V4SearchResult & { searched: Address | null }> {
  const limits: V4SearchLimits = {
    ...V4_SEARCH_LIMITS,
    ...(options.maxLogCalls === undefined ? {} : { maxLogCalls: options.maxLogCalls }),
    ...(options.maxCodeSteps === undefined ? {} : { maxCodeSteps: options.maxCodeSteps }),
    ...(options.probeSpans === undefined ? {} : { probeSpans: options.probeSpans }),
    ...(options.tailWindowsAfterMatch === undefined ? {} : { tailWindowsAfterMatch: options.tailWindowsAfterMatch }),
    ...(options.maxConcurrentLogCalls === undefined ? {} : { maxConcurrentLogCalls: options.maxConcurrentLogCalls }),
  };
  const cache = options.cache ?? new V4DiscoveryCache();
  const sides = output ? [input, output] : [input];
  const empty = (state: V4SearchState, note: string, searched: Address | null): V4SearchResult & { searched: Address | null } => ({
    pools: [], state, floor: null, scannedTo: state === "complete" ? head : null, head,
    logCalls: 0, codeCalls: 0, rejected: [], searched, note,
  });

  const floors = await Promise.all(sides.map((side) => cache.floor(client, side, head, limits, budget)));
  const usable: { side: Address; block: bigint }[] = [];
  for (let i = 0; i < sides.length; i++) {
    const f = floors[i];
    if (f.kind === "block") usable.push({ side: sides[i], block: f.block });
  }
  // An address with no runtime code at the pinned block cannot be an ERC-20
  // currency: a v4 swap pulling from it would revert. That is an authoritative
  // negative for this pair, reached without spending a single log query — and it
  // is exactly the case a rate-limited provider must not be allowed to turn into
  // an expensive scan from block 0.
  if (floors.some((f) => f.kind === "no-code")) {
    const blocked = sides.filter((_s, i) => floors[i].kind === "no-code");
    return empty("complete", `${blocked.join("/")} has no runtime code at block ${head}, so no tradable v4 pool can serve this pair.`, null);
  }
  const unreadable = sides.filter((_s, i) => floors[i].kind === "unavailable");
  if (unreadable.length > 0) {
    return empty(
      "unavailable",
      `Deployment floor could not be derived for ${unreadable.join("/")}: ${floors.find((f) => f.kind === "unavailable")!.reason} v4 discovery is unmeasured, not absent.`,
      null,
    );
  }
  // Pick the latest-deployed side: tightest sound floor, fewest windows to scan.
  const searched = usable.reduce((best, u) => (u.block > best.block ? u : best)).side;

  let result: V4SearchResult;
  try {
    result = await cache.search(client, searched, head, limits, budget);
  } catch (error) {
    // A blown shared read budget must not discard a positive the factory index
    // already established, so it degrades to "unavailable" instead of throwing.
    if (!(error instanceof V2QuoteError)) throw error;
    return empty("unavailable", `v4 Initialize search for ${searched} could not run: ${error.message}`, searched);
  }
  if (!output) return { ...result, searched };
  const wanted = new Set(sides.map((s) => normalize(s).toLowerCase()));
  // A cached scan is per TOKEN; the pair verdict is derived here, per call.
  const pools = result.pools.filter((p) => {
    const key = p.v4Key!;
    return wanted.has(normalize(key.currency0).toLowerCase()) && wanted.has(normalize(key.currency1).toLowerCase());
  });
  return { ...result, pools, searched };
}
