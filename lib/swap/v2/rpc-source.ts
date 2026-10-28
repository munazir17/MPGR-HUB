import "server-only";
import { directRpcHints } from "./rpc-hints";
import { fetchPairDepthHint } from "./depth-hint";
import { factoryIndexPools, PARTIAL_INDEX_VENUE_KINDS, type FactoryIndexResult } from "./rpc-index";
import { discoverV4Pools, V4_INITIALIZE_EVENT, V4DiscoveryCache, type V4DiscoveryOptions, type V4SearchResult } from "./rpc-v4";
import { decodeFunctionResult, encodeFunctionData, parseAbi, parseAbiItem, zeroAddress, type Address, type PublicClient } from "viem";
import { SWAP_PATH_VENUES } from "../swap-executor-config";
import { asset, V4_MANAGER, V2QuoteError, type CandidateOutcome, type DiscoveryStage, type LiquiditySource, type Pool } from "./discovery";
const events = {
  v2: parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"),
  v3: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"),
  slip: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)"),
  classic: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)"),
  // Uniswap v4 is NOT swept with the other venues: a PoolKey cannot be enumerated
  // from a factory getter and a block-0 log scan cannot be served by a
  // range-capped provider. It is discovered by rpc-v4.ts from canonical
  // `Initialize` logs, floored at a chain-derived deployment block.
  v4: V4_INITIALIZE_EVENT,
};
const venues = [
  { ...SWAP_PATH_VENUES.uniswapV2, event: events.v2 },
  { ...SWAP_PATH_VENUES.uniswapV3, event: events.v3 },
  { ...SWAP_PATH_VENUES.slipstream, event: events.slip },
  { ...SWAP_PATH_VENUES.aerodromeClassic, event: events.classic },
  { kind: 7 as const, router: V4_MANAGER, factory: V4_MANAGER, quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D" as Address, event: events.v4 },
];
const v2Abi = parseAbi(["function getAmountsOut(uint256 amountIn,address[] path) view returns(uint256[] amounts)"]);
const classicAbi = parseAbi(["function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns(uint256[] amounts)"]);
const uniAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
const slipAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
const v4Abi = parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)"]);
const weth = "0x4200000000000000000000000000000000000006";
const normalize = (a: Address) => a.toLowerCase() === zeroAddress ? asset(weth) : asset(a);
/** Bounded, because this text ends up in a coverage report row. */
const clip = (value: string): string => (value.length > 240 ? `${value.slice(0, 240)}...` : value);
const text = (error: unknown): string => {
  if (!(error instanceof Error)) return clip(String(error));
  const rich = error as Error & { shortMessage?: string; details?: string; data?: unknown };
  const base = rich.shortMessage || rich.message;
  const extra = [rich.details, typeof rich.data === "string" ? rich.data : undefined].filter(Boolean).join(" | ");
  return clip(extra ? `${base} (${extra})` : base);
};
/**
 * Classifies a failed venue call.
 *
 * A revert means the venue REFUSED to answer — for a Uniswap v4 pool that refusal
 * happens inside the pool's hooks contract or the token's own transfer rules, and it
 * is evidence about that pool, not about the pair's liquidity. A budget means we
 * stopped asking. Anything else is the provider's fault. All three are UNMEASURED;
 * none of them may be reported as missing liquidity.
 */
function classifyCallFailure(error: unknown): CandidateOutcome {
  const detail = text(error);
  if (/revert/i.test(detail)) return { cause: "reverted", detail };
  if (/budget exceeded|exceeded its \d+-call budget|exceeded \d+/i.test(detail)) return { cause: "budget", detail };
  return { cause: "rpc-error", detail };
}

/** Request-scoped canonical-event index. Production deployments can replace this
 * with a persistent index implementing the same LiquiditySource contract.
 * No fee tier, tick spacing, pool key, token catalog or bridge list is assumed.
 * Range-limited providers are partitioned; exceeding the work budget fails as
 * DISCOVERY_UNAVAILABLE rather than pretending a token has no liquidity. */
type Diagnostics = { factoryIndex: FactoryIndexResult | null; historyScan: "not-run" | "complete" | "unavailable"; v4: V4SearchResult | null };

/** The client shape the user-facing quote path needs. */
type SourceClient = Pick<PublicClient, "getLogs" | "getCode" | "call">
  & { getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }> };

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
};

/**
 * The discovery source for ONE user-facing quote, configured for a real paste.
 *
 * Three decisions, each with a reason that is a measurement rather than a preference:
 *
 * - **No whole-chain `eth_getLogs` sweep** (`maxSweepCalls` 0). The sweep scans from
 *   block 0 and bisects whenever the provider caps a range, so on Base's ~53M blocks it
 *   burns its entire call budget and then reports `unavailable` anyway. It is not needed
 *   to quote a direct pool: the factory getters answer that in a handful of `eth_call`s.
 *   The consequence is deliberate and honest — a pair with no pool anywhere is reported
 *   as `DISCOVERY_UNAVAILABLE`, never as missing liquidity, because absence is not
 *   provable without a complete enumeration. An operator whose RPC serves a wide log
 *   range can raise `MPGR_SWAP_V2_MAX_SWEEP_CALLS` and negatives become provable again.
 * - **A bounded v4 scan**, and only after the getters. v4 is the one venue family no
 *   factory getter can enumerate (a PoolKey includes an arbitrary hooks address), so it
 *   is searched from canonical `Initialize` logs by indexed currency, from a
 *   chain-derived deployment floor, capped at `MPGR_SWAP_V2_V4_LOG_CALLS` calls. A capped
 *   scan yields `DISCOVERY_UNAVAILABLE`, never `LIQUIDITY_UNAVAILABLE`.
 * - **A read budget for one quote, not for a batch.** The production default of 4096 was
 *   sized for a single answer; 1024 covers a ~26-step deployment-floor search, a bounded
 *   v4 scan and the venue quotes, and fails fast rather than hanging when a provider is
 *   slow.
 *
 * The v4 cache is per call on purpose: it is keyed by `token@block`, so sharing one
 * across requests would grow without bound in a long-lived server for no benefit, since
 * each quote pins a fresh block.
 */
export function swapV2QuoteSource(client: SourceClient, blockNumber: bigint): RpcV2LiquiditySource {
  return new RpcV2LiquiditySource(
    client, blockNumber,
    envInt("MPGR_SWAP_V2_MAX_READS", 1024),
    envInt("MPGR_SWAP_V2_MAX_SWEEP_CALLS", 0),
    { cache: new V4DiscoveryCache(), maxLogCalls: envInt("MPGR_SWAP_V2_V4_LOG_CALLS", 64) },
    true,
  );
}

export class RpcV2LiquiditySource implements LiquiditySource {
  private cache = new Map<string, Promise<readonly Pool[]>>();
  /** Diagnostics PER PAIR. A single mutable field is not enough: `pools()` runs
   * concurrently (the coverage matrix probes many pairs at once), so attribution for
   * one pair would otherwise read whichever load happened to finish last. */
  private diagByKey = new Map<string, Diagnostics>();
  /** One promise per (stage, pair), so a stage is never run twice for the same pair. */
  private stageCache = new Map<string, Promise<readonly Pool[]>>();
  private reads = 0;
  /** What the last `pools(input, output)` load could actually establish. Lets a
   * caller tell "no compatible pool exists" apart from "we could not finish
   * looking" — the distinction the coverage matrix must never blur. */
  private lastDiagnostics: Diagnostics = { factoryIndex: null, historyScan: "not-run", v4: null };
  diagnostics(): Diagnostics { return this.lastDiagnostics; }
  /**
   * What discovery could establish for ONE pair.
   *
   * `diagnostics()` reports whichever pair was touched last, and with staged discovery
   * that is not necessarily the pair a caller means: a quote attempt ends by asking for
   * multi-hop neighbours, which fails fast and leaves an empty record behind. Asking per
   * pair is the only unambiguous form, so attribution and the coverage matrix both use it.
   */
  diagnosticsFor(input: Address, output?: Address): Diagnostics {
    return this.diagByKey.get(RpcV2LiquiditySource.key(input, output))
      ?? { factoryIndex: null, historyScan: "not-run", v4: null };
  }
  private static key(input: Address, output?: Address): string { return `${input.toLowerCase()}:${output?.toLowerCase() ?? "*"}`; }
  /**
   * Whether "no compatible pool exists for this pair" is currently provable.
   *
   * It is not enough for discovery to have returned pools: if the canonical sweep
   * could not run, or the v4 `Initialize` scan stopped before the pinned block, or a
   * factory index failed for some venue, then a pool that quotes zero may simply be
   * the only pool we managed to find. Reporting that as missing liquidity would be a
   * fabricated negative, so this stays false and the pair stays UNMEASURED.
   */
  negativeProvable(input: Address, output?: Address): boolean {
    const diag = this.diagByKey.get(RpcV2LiquiditySource.key(input, output));
    if (!diag) return false; // never loaded: nothing was established either way
    if (diag.historyScan !== "complete") return false;
    if (!diag.v4 || diag.v4.state !== "complete") return false;
    if (diag.factoryIndex && diag.factoryIndex.failedKinds.length > 0) return false;
    return true;
  }
  /** What discovery could and could not establish for this pair, verbatim. */
  discoveryNotes(input: Address, output?: Address): string[] {
    const diag = this.diagByKey.get(RpcV2LiquiditySource.key(input, output));
    if (!diag) return ["discovery was never run for this pair"];
    const notes: string[] = [`canonical event sweep ${diag.historyScan}`];
    if (diag.factoryIndex) {
      notes.push(`factory index ${diag.factoryIndex.failedKinds.length ? `failed for venue kind(s) ${diag.factoryIndex.failedKinds.join("/")}` : "complete for every venue with a getter"}`
        + ` (partial by construction for kind(s) ${PARTIAL_INDEX_VENUE_KINDS.join("/")})`);
    } else notes.push("factory index did not run");
    if (diag.v4) notes.push(`v4 Initialize search ${diag.v4.state}: ${diag.v4.note}`);
    else notes.push("v4 Initialize search did not run");
    return notes;
  }
  /**
   * @param maxSweepCalls Cap on `eth_getLogs` calls in the universal canonical-event
   * sweep. The sweep scans from block 0, which a range-capped provider cannot serve,
   * and it dominated per-pair latency: 96 of 212 coverage probes timed out and 148
   * never ran. Set it to 0 to rely on the bounded factory index alone — every pair
   * then resolves in a handful of `eth_call`s. A capped sweep is recorded as
   * UNAVAILABLE, so a negative verdict is never reported as missing liquidity.
   */
  constructor(
    private client: Pick<PublicClient, "getLogs" | "getCode" | "call"> & {getBlock(args: {blockNumber: bigint}): Promise<{timestamp: bigint}>},
    readonly blockNumber: bigint,
    private maxReads = 4096,
    private maxSweepCalls = 2000,
    /** Bounded Uniswap v4 discovery. Pass a shared `cache` when the same pinned
     * block is probed for many pairs (the coverage matrix does): a token's
     * deployment floor and its `Initialize` scan are then paid for once per run
     * instead of once per pair. */
    private v4Options: V4DiscoveryOptions = { cache: new V4DiscoveryCache() },
    /** User-facing quotes only. The coverage matrix constructs this class
     * directly and must not add an indexer round-trip to every pair. */
    private depthHints = false,
  ) {}
  private sweepCalls = 0;
  private budget() { if (++this.reads > this.maxReads) throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "RPC pool discovery budget exceeded; use a complete liquidity index"); }
  async hints(input: Address, output: Address): Promise<readonly Pool[]> {
    try { return await directRpcHints(this.client, input, output, this.blockNumber); }
    catch { return []; } // Never treat missing hints as no liquidity.
  }
  /**
   * Whether the direct book is thin next to a WETH/USDC book.
   *
   * Off during unit tests: the staged-quote suite pins zero `eth_getLogs` for a
   * fair getter, and a live indexer must not be able to open a v4 scan there.
   * Production does not set `VITEST`. A failure is "unknown", so the quote falls
   * back to size impact and the factory hub.
   */
  async depthHint(tokenIn: Address, tokenOut: Address): Promise<{ thin: boolean } | null> {
    if (!this.depthHints || process.env.VITEST) return null;
    try {
      const thin = await fetchPairDepthHint(tokenIn, tokenOut);
      return thin == null ? null : { thin };
    } catch {
      return null;
    }
  }
  pools(input: Address, output?: Address): Promise<readonly Pool[]> {
    const key = RpcV2LiquiditySource.key(input, output);
    if (!this.cache.has(key)) this.cache.set(key, this.load(key, input, output));
    return this.cache.get(key)!;
  }
  private async load(key: string, input: Address, output?: Address): Promise<readonly Pool[]> {
    const diag: Diagnostics = { factoryIndex: null, historyScan: "not-run", v4: null };
    // Registered BEFORE the load runs so the individual stages — which may also be
    // reached directly through `directStages` — write into the same record this load
    // inspects, rather than a second one nobody reads.
    this.diagByKey.set(key, diag);
    try {
      return await this.loadInner(diag, input, output);
    } finally {
      // Recorded on the way out whether the load returned pools or threw, so a pair
      // that failed the honesty gate can still explain what it managed to establish.
      this.lastDiagnostics = diag;
      this.diagByKey.set(key, diag);
    }
  }
  /** The diagnostics record for a pair, created on first touch. Also becomes the record
   * `diagnostics()` reports, because with staged discovery a caller may never go through
   * `pools()` at all — and a stale "not-run" reads as "nothing was attempted". */
  private diagFor(input: Address, output?: Address): Diagnostics {
    const key = RpcV2LiquiditySource.key(input, output);
    let diag = this.diagByKey.get(key);
    if (!diag) {
      diag = { factoryIndex: null, historyScan: "not-run", v4: null };
      this.diagByKey.set(key, diag);
    }
    this.lastDiagnostics = diag;
    return diag;
  }
  /** Runs a stage at most once per pair. `pools()` and `directStages()` share this, so
   * asking for a quote twice — or asking for the union after the stages — never repeats
   * an RPC call. */
  private memo(key: string, run: () => Promise<readonly Pool[]>): Promise<readonly Pool[]> {
    if (!this.stageCache.has(key)) this.stageCache.set(key, run());
    return this.stageCache.get(key)!;
  }
  /**
   * STAGE 1 — factory getters. One `eth_call` per candidate pool, no `eth_getLogs` at
   * all, so it works on any provider including a range-capped public RPC and it is fast
   * enough to be the whole answer for most pairs. Coverage is per venue and stated in
   * `rpc-index.ts`: complete for Uniswap v2 and Aerodrome Classic, complete over the
   * canonical fee tiers for Uniswap v3, and PARTIAL for Slipstream, whose spacing set
   * was never verified from its ABI and is therefore not invented.
   */
  private indexStage(input: Address, output: Address): Promise<readonly Pool[]> {
    return this.memo(`index:${RpcV2LiquiditySource.key(input, output)}`, async () => {
      const diag = this.diagFor(input, output);
      try {
        const index = await factoryIndexPools(this.client, input, output, this.blockNumber, () => this.budget());
        diag.factoryIndex = index;
        return index.pools;
      } catch (error) {
        // An index that could not run leaves the later stages; it is not a verdict of
        // "no liquidity".
        if (!(error instanceof V2QuoteError)) throw error;
        diag.factoryIndex = null;
        return [];
      }
    });
  }
  /**
   * STAGE 2 — bounded Uniswap v4 discovery against the canonical PoolManager. No factory
   * getter can enumerate a PoolKey (hooks is an arbitrary address), so v4 comes from
   * canonical `Initialize` logs searched by INDEXED CURRENCY from a chain-derived
   * deployment floor — never from block 0 and never from a third-party hint. Every
   * accepted PoolKey is re-derived and must equal the log's own indexed pool id.
   *
   * Run only after stage 1, and only when stage 1 produced nothing quotable: on a
   * provider that serves ten blocks per query this scan is the expensive part.
   */
  private v4Stage(input: Address, output?: Address): Promise<readonly Pool[]> {
    return this.memo(`v4:${RpcV2LiquiditySource.key(input, output)}`, async () => {
      const diag = this.diagFor(input, output);
      try {
        const v4 = await discoverV4Pools(this.client, input, output, this.blockNumber, this.v4Options, () => this.budget());
        diag.v4 = v4;
        return v4.pools;
      } catch (error) {
        // A search that could not run is "we could not look", never "no v4 pool".
        if (!(error instanceof V2QuoteError)) throw error;
        diag.v4 = {
          pools: [], state: "unavailable", floor: null, scannedTo: null, head: this.blockNumber,
          logCalls: 0, codeCalls: 0, rejected: [], note: error.message,
        };
        return [];
      }
    });
  }
  /**
   * Ordered direct-pair discovery: getters first, v4 second, and the whole-history
   * canonical sweep only when it is actually enabled. `discoverV2Quote` stops at the
   * first stage that yields a quotable pool. It opens the v4 scan when that quote's
   * own size impact is at least 5%, or when the direct book's liquidity is thin
   * next to a WETH/USDC book. A healthy getter pair issues no eth_getLogs.
   */
  directStages(input: Address, output: Address): readonly DiscoveryStage[] {
    const stages: DiscoveryStage[] = [
      {
        name: "factory-index",
        pools: () => this.indexStage(input, output),
        // "No getter failed" is NOT "every pool was enumerated". Slipstream's tick-spacing
        // set is not derivable from its ABI, so this stage is partial for kind 1 by
        // construction (PARTIAL_INDEX_VENUE_KINDS) and can never on its own prove that no
        // pool exists. Reporting it complete would be the kind of quiet overclaim that
        // turns a bounded search into a fabricated negative.
        complete: () => {
          const index = this.diagFor(input, output).factoryIndex;
          return !!index && index.complete && index.partialKinds.length === 0;
        },
      },
      {
        name: "v4-canonical-logs",
        pools: () => this.v4Stage(input, output),
        complete: () => this.diagFor(input, output).v4?.state === "complete",
      },
    ];
    // Always offered, even when disabled, so the trace says WHY the sweep contributed
    // nothing instead of silently omitting a venue family. When `maxSweepCalls` is 0 the
    // stage costs no RPC call at all: it records `unavailable` and returns nothing, which
    // is what keeps a later "no pool" from being read as a proven negative.
    stages.push({
      name: "canonical-sweep",
      pools: () => this.sweepStage(input, output),
      complete: () => this.diagFor(input, output).historyScan === "complete",
    });
    return stages;
  }
  private async loadInner(diag: Diagnostics, input: Address, output?: Address): Promise<readonly Pool[]> {
    // 0. Multi-hop neighbour enumeration (no `output`) can only be answered by the
    //    canonical event sweep: the factory index is pair-shaped, and v4 has no
    //    enumerable getter for "every pool this token is in" other than its own
    //    Initialize logs. Without a usable log range that enumeration cannot
    //    complete, so fail fast instead of spending a whole budget to reach the
    //    same verdict. A PARTIAL neighbour set is worse than none here, because
    //    discoverV2Quote would convert it into a false "no liquidity".
    if (!output && this.maxSweepCalls <= 0) {
      throw new V2QuoteError("DISCOVERY_UNAVAILABLE",
        "Liquidity-neighbour enumeration needs a historical log range, and the canonical sweep is disabled (maxSweepCalls=0); multi-hop discovery for this token is unmeasured, not absent.");
    }
    // The union of every stage, in the same order `directStages` offers them and through
    // the same memoised calls, so asking for the union after a staged quote costs nothing
    // extra. `pools()` keeps its historical meaning — the whole answer — while
    // `directStages` lets a caller stop at the first stage that can quote.
    const result = new Map<string, Pool>();
    if (output) for (const pool of await this.indexStage(input, output)) result.set(pool.id, pool);
    for (const pool of await this.v4Stage(input, output)) result.set(pool.id, pool);
    for (const pool of await this.sweepStage(input, output)) result.set(pool.id, pool);
    // HONESTY RULE, in two halves, because the two directions are not symmetric.
    //
    // A POSITIVE is always safe to return. Every pool in `result` was verified
    // against a canonical source: factory equality plus the pool's own metadata
    // (index), the factory's own creation event (sweep), or a re-derived v4 pool
    // id equal to the indexed id in the PoolManager's `Initialize` log. An
    // incomplete search can cost route QUALITY; it cannot invent a pool.
    if (result.size > 0) return [...result.values()];
    //
    // A NEGATIVE is the claim that no compatible pool exists, and it is only made
    // when every venue family was actually enumerated to completion for this pair:
    // the getter-backed venues by a completed sweep, and v4 by a scan that reached
    // the pinned block. Slipstream's index is partial by construction (see
    // PARTIAL_INDEX_VENUE_KINDS), so an index-only negative is never sufficient.
    // Anything less is DISCOVERY_UNAVAILABLE, never LIQUIDITY_UNAVAILABLE.
    const index = diag.factoryIndex;
    const v4 = diag.v4;
    if (!(diag.historyScan === "complete" && !!v4 && v4.state === "complete")) {
      throw new V2QuoteError("DISCOVERY_UNAVAILABLE",
        `No compatible pool could be established for this pair: canonical sweep ${diag.historyScan}`
        + ` (index failed venues: ${index ? index.failedKinds.join("/") || "none" : "not-run"}; partial kinds: ${PARTIAL_INDEX_VENUE_KINDS.join("/")})`
        + `; v4 search ${v4 ? `${v4.state} — ${v4.note}` : "did not run"}`);
    }
    return [];
  }
  /**
   * STAGE 3 — the universal canonical-event sweep from block 0 over the four
   * getter-backed venues. It is the only way to complete Slipstream, whose spacing set
   * is not enumerable from its ABI, and the only way to enumerate multi-hop neighbours.
   *
   * It needs a real historical log range, so on a range-capped provider it burns its call
   * budget bisecting and then reports `unavailable`. That is why it is last, why the
   * user-facing quote path disables it, and why a pair that reaches it and finds nothing
   * is reported as DISCOVERY_UNAVAILABLE rather than as missing liquidity.
   */
  private sweepStage(input: Address, output?: Address): Promise<readonly Pool[]> {
    return this.memo(`sweep:${RpcV2LiquiditySource.key(input, output)}`, async () => {
      const diag = this.diagFor(input, output);
      const found = new Map<string, Pool>();
      if (this.maxSweepCalls <= 0) {
        // Disabled: the sweep cannot run, so nothing here is complete. Recording that is
        // what keeps a later "no pool" from being read as a proven negative.
        diag.historyScan = "unavailable";
        return [];
      }
      let historyScan: "complete" | "unavailable" = "complete";
      try {
      for (const v of venues) {
        if (v.kind === 7) continue; // handled by the bounded v4 search above
        // Creation events index token0/token1 in sorted order, so one filter names
        // the pair. With no `output` this is neighbour enumeration instead: either
        // indexed position of the single token.
        const filters: Record<string, Address>[] = !output
          ? [{ token0: input }, { token1: input }]
          : BigInt(input) < BigInt(output)
            ? [{ token0: input, token1: output }]
            : [{ token0: output, token1: input }];
        for (const args of filters) {
          const scan = async (fromBlock: bigint, toBlock: bigint): Promise<void> => {
            if (++this.sweepCalls > this.maxSweepCalls) {
              throw new V2QuoteError("DISCOVERY_UNAVAILABLE", `Canonical pool log sweep exceeded its ${this.maxSweepCalls}-call budget`);
            }
            this.budget();
            try {
              const logs = await this.client.getLogs({ address: v.factory, event: v.event, args: args as never, fromBlock, toBlock, strict: true });
              for (const log of logs) {
                const a = log.args as Record<string, Address | number | bigint | boolean>;
                const c0 = a.token0 as Address, c1 = a.token1 as Address;
                const pool = (a.pool ?? a.pair) as Address;
                const id = `${v.factory.toLowerCase()}:${pool.toLowerCase()}`;
                found.set(id, { id, pool, router: v.router, factory: v.factory, kind: v.kind, token0: normalize(c0), token1: normalize(c1), poolFee: v.kind === 2 ? Number(a.fee) : 0, tickSpacing: v.kind === 1 ? Number(a.tickSpacing) : 0, stable: a.stable === true });
              }
            } catch (error) {
              if (error instanceof V2QuoteError) throw error;
              // Only explicit range/size errors warrant subdivision. Network,
              // authorization and rate-limit failures must not fan out requests.
              const text = error instanceof Error ? error.message : "";
              if (toBlock - fromBlock < 1n || !/range|too many|more than|response size|limit.*block/i.test(text)) throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "Canonical pool log query unavailable");
              const mid = (fromBlock + toBlock) / 2n; await scan(fromBlock, mid); await scan(mid + 1n, toBlock);
            }
          };
          await scan(0n, this.blockNumber);
        }
      }
      } catch (error) {
        if (error instanceof V2QuoteError && error.code === "DISCOVERY_UNAVAILABLE") historyScan = "unavailable";
        else throw error;
      }
      diag.historyScan = historyScan;
      return [...found.values()];
    });
  }

  /**
   * Why a venue did not answer, instead of a bare number.
   *
   * This is the method that makes MPGR's two directions distinguishable. Both sides of
   * the pair discover the SAME native-currency v4 pool; before this existed, a revert
   * and a zero answer both came back as `0n` and were indistinguishable from "no pool
   * was ever found", so the SELL direction could only be reported as an undifferentiated
   * provider failure.
   */
  async quoteAttempt(p: Pool, input: Address, amount: bigint): Promise<CandidateOutcome> {
    try { this.budget(); } catch (error) { return { cause: "budget", detail: text(error) }; }
    const output = p.token0.toLowerCase() === input.toLowerCase() ? p.token1 : p.token0;
    const v = venues.find(v => v.kind === p.kind)!;
    if (p.router.toLowerCase() !== v.router.toLowerCase() || p.factory.toLowerCase() !== v.factory.toLowerCase()) {
      return { cause: "venue-error", code: "FEE_POLICY_INVALID", detail: "Noncanonical venue" };
    }
    if (p.kind === 7 && !p.v4Key) return { cause: "venue-error", code: "FEE_POLICY_INVALID", detail: "Missing v4 PoolKey" };
    const target = p.kind === 3 || p.kind === 4 ? p.router : v.quoter!;
    let data: `0x${string}`;
    try {
      const code = await this.client.getCode({ address: target, blockNumber: this.blockNumber });
      if (!code || code === "0x") return { cause: "venue-error", code: "DISCOVERY_UNAVAILABLE", detail: "Quote adapter has no Base code" };
      if (p.kind === 3) data = encodeFunctionData({ abi: v2Abi, functionName: "getAmountsOut", args: [amount, [input, output]] });
      else if (p.kind === 4) data = encodeFunctionData({ abi: classicAbi, functionName: "getAmountsOut", args: [amount, [{ from: input, to: output, stable: p.stable, factory: p.factory }]] });
      else if (p.kind === 2) data = encodeFunctionData({ abi: uniAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: input, tokenOut: output, amountIn: amount, fee: p.poolFee, sqrtPriceLimitX96: 0n }] });
      else if (p.kind === 1) data = encodeFunctionData({ abi: slipAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: input, tokenOut: output, amountIn: amount, tickSpacing: p.tickSpacing, sqrtPriceLimitX96: 0n }] });
      // zeroForOne is decided by the PoolKey's OWN currency order, with the native side
      // read as canonical WETH: for a pool whose currency0 is the zero address, selling
      // the token is currency1 -> currency0, and buying it is currency0 -> currency1.
      else data = encodeFunctionData({ abi: v4Abi, functionName: "quoteExactInputSingle", args: [{ poolKey: p.v4Key!, zeroForOne: normalize(p.v4Key!.currency0).toLowerCase() === input.toLowerCase(), exactAmount: amount, hookData: "0x" }] });
    } catch (error) { return classifyCallFailure(error); }
    try {
      const result = await this.client.call({ to: target, data, blockNumber: this.blockNumber });
      // An empty response is treated as a zero answer, exactly as before: the venue was
      // reached and returned nothing to decode.
      if (!result.data) return { cause: "zero-output" };
      const amountOut: bigint =
        p.kind === 3 ? decodeFunctionResult({ abi: v2Abi, functionName: "getAmountsOut", data: result.data })[1]
        : p.kind === 4 ? decodeFunctionResult({ abi: classicAbi, functionName: "getAmountsOut", data: result.data })[1]
        : p.kind === 2 ? decodeFunctionResult({ abi: uniAbi, functionName: "quoteExactInputSingle", data: result.data })[0]
        : p.kind === 1 ? decodeFunctionResult({ abi: slipAbi, functionName: "quoteExactInputSingle", data: result.data })[0]
        : decodeFunctionResult({ abi: v4Abi, functionName: "quoteExactInputSingle", data: result.data })[0];
      return amountOut > 0n ? { cause: "quoted", amountOut } : { cause: "zero-output" };
    } catch (error) { return classifyCallFailure(error); }
  }
  /**
   * The legacy single-number contract, now derived from `quoteAttempt` so the two can
   * never disagree: a revert and a zero both still return 0n here, and only the richer
   * method knows which of the two happened.
   */
  async quote(p: Pool, input: Address, amount: bigint): Promise<bigint> {
    const outcome = await this.quoteAttempt(p, input, amount);
    switch (outcome.cause) {
      case "quoted": return outcome.amountOut;
      case "zero-output": case "reverted": return 0n;
      case "venue-error": throw new V2QuoteError(outcome.code, outcome.detail);
      case "budget": throw new V2QuoteError("DISCOVERY_UNAVAILABLE", outcome.detail);
      case "rpc-error": throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "Venue quote RPC unavailable");
    }
  }
}
