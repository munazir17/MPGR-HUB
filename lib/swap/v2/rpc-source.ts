import "server-only";
import { directRpcHints } from "./rpc-hints";
import { factoryIndexPools, PARTIAL_INDEX_VENUE_KINDS, type FactoryIndexResult } from "./rpc-index";
import { decodeFunctionResult, encodeFunctionData, parseAbi, parseAbiItem, zeroAddress, type Address, type PublicClient } from "viem";
import { SWAP_PATH_VENUES } from "../swap-executor-config";
import { asset, V4_MANAGER, V2QuoteError, type LiquiditySource, type Pool, type V4Key } from "./discovery";
const events = {
  v2: parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"),
  v3: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"),
  slip: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)"),
  classic: parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)"),
  v4: parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"),
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
  private lastDiagnostics: { factoryIndex: FactoryIndexResult | null; historyScan: "not-run" | "complete" | "unavailable" } =
    { factoryIndex: null, historyScan: "not-run" };
  diagnostics(): { factoryIndex: FactoryIndexResult | null; historyScan: "not-run" | "complete" | "unavailable" } { return this.lastDiagnostics; }
  constructor(private client: Pick<PublicClient, "getLogs" | "getCode" | "call"> & {getBlock(args: {blockNumber: bigint}): Promise<{timestamp: bigint}>}, readonly blockNumber: bigint, private maxReads = 4096) {}
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
    this.lastDiagnostics = { factoryIndex: null, historyScan: "not-run" };
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
    // 2. Universal canonical-event sweep. Needs a real historical log range; when
    //    the provider cannot serve it, record that instead of aborting, because
    //    step 1 may already have produced an authoritative answer.
    let historyScan: "complete" | "unavailable" = "complete";
    try {
    for (const v of venues) {
      const variants = (a: Address) => v.kind === 7 && a.toLowerCase() === weth ? [a, zeroAddress] : [a];
      const filters: Record<string, Address>[] = [];
      const names = v.kind === 7 ? ["currency0", "currency1"] : ["token0", "token1"];
      for (const a of variants(input)) {
        if (output) for (const b of variants(output)) {
          const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]; filters.push({ [names[0]]: x, [names[1]]: y });
        } else filters.push({ [names[0]]: a }, { [names[1]]: a });
      }
      for (const args of filters) {
        const scan = async (fromBlock: bigint, toBlock: bigint): Promise<void> => {
          this.budget();
          try {
            const logs = await this.client.getLogs({ address: v.factory, event: v.event, args: args as never, fromBlock, toBlock, strict: true });
            for (const log of logs) {
              const a = log.args as Record<string, Address | number | bigint | boolean>;
              const c0 = (a.token0 ?? a.currency0) as Address, c1 = (a.token1 ?? a.currency1) as Address;
              const key: V4Key | undefined = v.kind === 7 ? { currency0: c0, currency1: c1, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: a.hooks as Address } : undefined;
              const pool = (v.kind === 7 ? V4_MANAGER : a.pool ?? a.pair) as Address;
              const id = `${v.factory.toLowerCase()}:${String(a.id ?? pool).toLowerCase()}`;
              result.set(id, { id, pool, router: v.router, factory: v.factory, kind: v.kind, token0: normalize(c0), token1: normalize(c1), poolFee: v.kind === 2 ? Number(a.fee) : 0, tickSpacing: v.kind === 1 ? Number(a.tickSpacing) : 0, stable: a.stable === true, v4Key: key });
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
    // Honesty rule: if the universal sweep could not complete AND the factory
    // index did not produce an authoritative negative, then nothing is known about
    // this pair. That is DISCOVERY_UNAVAILABLE, never LIQUIDITY_UNAVAILABLE.
    // Venues whose enumeration is partial (see PARTIAL_INDEX_VENUE_KINDS) and v4
    // are only fully covered by the sweep, so their absence is not a verdict.
    const index = this.lastDiagnostics.factoryIndex;
    const authoritativeNegative = historyScan === "complete" ||
      (!!index && index.complete && result.size > 0);
    if (!authoritativeNegative) {
      throw new V2QuoteError("DISCOVERY_UNAVAILABLE",
        `Canonical pool log query unavailable and no authoritative factory answer (index failed venues: ${index ? index.failedKinds.join("/") || "none" : "not-run"}; partial kinds: ${PARTIAL_INDEX_VENUE_KINDS.join("/")})`);
    }
    return [...result.values()];
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
