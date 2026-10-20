import "server-only";
import { directRpcHints } from "./rpc-hints";
import { factoryIndexPools, PARTIAL_INDEX_VENUE_KINDS, type FactoryIndexResult } from "./rpc-index";
import { discoverV4Pools, V4_INITIALIZE_EVENT, V4DiscoveryCache, type V4DiscoveryOptions, type V4SearchResult } from "./rpc-v4";
import { decodeFunctionResult, encodeFunctionData, parseAbi, parseAbiItem, zeroAddress, type Address, type PublicClient } from "viem";
import { SWAP_PATH_VENUES } from "../swap-executor-config";
import { asset, V4_MANAGER, V2QuoteError, type LiquiditySource, type Pool } from "./discovery";
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

/** Request-scoped canonical-event index. Production deployments can replace this
 * with a persistent index implementing the same LiquiditySource contract.
 * No fee tier, tick spacing, pool key, token catalog or bridge list is assumed.
 * Range-limited providers are partitioned; exceeding the work budget fails as
 * DISCOVERY_UNAVAILABLE rather than pretending a token has no liquidity. */
export class RpcV2LiquiditySource implements LiquiditySource {
  private cache = new Map<string, Promise<readonly Pool[]>>();
  private reads = 0;
  /** What the last `pools(input, output)` load could actually establish. Lets a
   * caller tell "no compatible pool exists" apart from "we could not finish
   * looking" — the distinction the coverage matrix must never blur. */
  private lastDiagnostics: { factoryIndex: FactoryIndexResult | null; historyScan: "not-run" | "complete" | "unavailable"; v4: V4SearchResult | null } =
    { factoryIndex: null, historyScan: "not-run", v4: null };
  diagnostics(): { factoryIndex: FactoryIndexResult | null; historyScan: "not-run" | "complete" | "unavailable"; v4: V4SearchResult | null } { return this.lastDiagnostics; }
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
  ) {}
  private sweepCalls = 0;
  private budget() { if (++this.reads > this.maxReads) throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "RPC pool discovery budget exceeded; use a complete liquidity index"); }
  async hints(input: Address, output: Address): Promise<readonly Pool[]> {
    try { return await directRpcHints(this.client, input, output, this.blockNumber); }
    catch { return []; } // Never treat missing hints as no liquidity.
  }
  pools(input: Address, output?: Address): Promise<readonly Pool[]> {
    const key = `${input.toLowerCase()}:${output?.toLowerCase() ?? "*"}`;
    if (!this.cache.has(key)) this.cache.set(key, this.load(input, output));
    return this.cache.get(key)!;
  }
  private async load(input: Address, output?: Address): Promise<readonly Pool[]> {
    const result = new Map<string, Pool>();
    this.lastDiagnostics = { factoryIndex: null, historyScan: "not-run", v4: null };
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
    // 1. Bounded factory index: one eth_call per candidate, no log range needed,
    //    so it works on any provider including a range-capped public RPC.
    if (output) {
      try {
        const index = await factoryIndexPools(this.client, input, output, this.blockNumber, () => this.budget());
        this.lastDiagnostics.factoryIndex = index;
        for (const p of index.pools) result.set(p.id, p);
      } catch (error) {
        // An index that could not run leaves us with the sweep below; it is not a
        // verdict of "no liquidity".
        if (!(error instanceof V2QuoteError)) throw error;
        this.lastDiagnostics.factoryIndex = null;
      }
    }
    // 2. Bounded Uniswap v4 discovery. No factory getter can enumerate a PoolKey
    //    (hooks is an arbitrary address), so v4 comes from canonical `Initialize`
    //    logs — searched by INDEXED CURRENCY from a chain-derived deployment floor,
    //    never from block 0 and never from a third-party hint. Every accepted
    //    PoolKey is re-derived and must equal the log's own indexed pool id.
    try {
      const v4 = await discoverV4Pools(this.client, input, output, this.blockNumber, this.v4Options, () => this.budget());
      this.lastDiagnostics.v4 = v4;
      for (const p of v4.pools) result.set(p.id, p);
    } catch (error) {
      // A search that could not run is "we could not look", never "no v4 pool".
      if (!(error instanceof V2QuoteError)) throw error;
      this.lastDiagnostics.v4 = {
        pools: [], state: "unavailable", floor: null, scannedTo: null, head: this.blockNumber,
        logCalls: 0, codeCalls: 0, rejected: [], note: error.message,
      };
    }
    // 3. Universal canonical-event sweep over the four getter-backed venues. Needs
    //    a real historical log range; when the provider cannot serve it, record
    //    that instead of aborting, because steps 1-2 may already have produced an
    //    authoritative answer.
    let historyScan: "complete" | "unavailable" = "complete";
    try {
    for (const v of venues) {
      if (v.kind === 7) continue; // handled by the bounded v4 search above
      const filters: Record<string, Address>[] = [];
      const names = ["token0", "token1"];
      for (const a of [input]) {
        if (output) for (const b of [output]) {
          const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]; filters.push({ [names[0]]: x, [names[1]]: y });
        } else filters.push({ [names[0]]: a }, { [names[1]]: a });
      }
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
              result.set(id, { id, pool, router: v.router, factory: v.factory, kind: v.kind, token0: normalize(c0), token1: normalize(c1), poolFee: v.kind === 2 ? Number(a.fee) : 0, tickSpacing: v.kind === 1 ? Number(a.tickSpacing) : 0, stable: a.stable === true });
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
    this.lastDiagnostics.historyScan = historyScan;
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
    const index = this.lastDiagnostics.factoryIndex;
    const v4 = this.lastDiagnostics.v4;
    if (!(historyScan === "complete" && !!v4 && v4.state === "complete")) {
      throw new V2QuoteError("DISCOVERY_UNAVAILABLE",
        `No compatible pool could be established for this pair: canonical sweep ${historyScan}`
        + ` (index failed venues: ${index ? index.failedKinds.join("/") || "none" : "not-run"}; partial kinds: ${PARTIAL_INDEX_VENUE_KINDS.join("/")})`
        + `; v4 search ${v4 ? `${v4.state} — ${v4.note}` : "did not run"}`);
    }
    return [];
  }
  async quote(p: Pool, input: Address, amount: bigint): Promise<bigint> {
    this.budget();
    const output = p.token0.toLowerCase() === input.toLowerCase() ? p.token1 : p.token0;
    const v = venues.find(v => v.kind === p.kind)!;
    if (p.router.toLowerCase() !== v.router.toLowerCase() || p.factory.toLowerCase() !== v.factory.toLowerCase()) throw new V2QuoteError("FEE_POLICY_INVALID", "Noncanonical venue");
    const target = p.kind === 3 || p.kind === 4 ? p.router : v.quoter!;
    const code = await this.client.getCode({ address: target, blockNumber: this.blockNumber });
    if (!code || code === "0x") throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "Quote adapter has no Base code");
    let data: `0x${string}`;
    if (p.kind === 3) data = encodeFunctionData({ abi: v2Abi, functionName: "getAmountsOut", args: [amount, [input, output]] });
    else if (p.kind === 4) data = encodeFunctionData({ abi: classicAbi, functionName: "getAmountsOut", args: [amount, [{ from: input, to: output, stable: p.stable, factory: p.factory }]] });
    else if (p.kind === 2) data = encodeFunctionData({ abi: uniAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: input, tokenOut: output, amountIn: amount, fee: p.poolFee, sqrtPriceLimitX96: 0n }] });
    else if (p.kind === 1) data = encodeFunctionData({ abi: slipAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: input, tokenOut: output, amountIn: amount, tickSpacing: p.tickSpacing, sqrtPriceLimitX96: 0n }] });
    else {
      if (!p.v4Key) throw new V2QuoteError("FEE_POLICY_INVALID", "Missing v4 PoolKey");
      data = encodeFunctionData({ abi: v4Abi, functionName: "quoteExactInputSingle", args: [{ poolKey: p.v4Key, zeroForOne: normalize(p.v4Key.currency0).toLowerCase() === input.toLowerCase(), exactAmount: amount, hookData: "0x" }] });
    }
    try {
      const result = await this.client.call({ to: target, data, blockNumber: this.blockNumber });
      if (!result.data) return 0n;
      if (p.kind === 3) return decodeFunctionResult({ abi: v2Abi, functionName: "getAmountsOut", data: result.data })[1];
      if (p.kind === 4) return decodeFunctionResult({ abi: classicAbi, functionName: "getAmountsOut", data: result.data })[1];
      if (p.kind === 2) return decodeFunctionResult({ abi: uniAbi, functionName: "quoteExactInputSingle", data: result.data })[0];
      if (p.kind === 1) return decodeFunctionResult({ abi: slipAbi, functionName: "quoteExactInputSingle", data: result.data })[0];
      return decodeFunctionResult({ abi: v4Abi, functionName: "quoteExactInputSingle", data: result.data })[0];
    } catch (error) {
      if (error instanceof Error && /revert/i.test(error.message)) return 0n;
      throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "Venue quote RPC unavailable");
    }
  }
}
