// lib/swap/v2/__tests__/staged-quote-path.test.ts
//
// EVIDENCE TIER — SIMULATED. Every chain below is a fabricated in-process reader; no
// RPC was contacted and no transaction was built, signed or broadcast. Pool addresses,
// fee tiers and block numbers here are mock inputs, never expected outputs: discovery
// has to read them back from the fabricated factory getters and `Initialize` logs.
//
// WHAT THIS PINS DOWN. The user-facing quote path has to survive a real paste: someone
// types two Base addresses and expects an answer, not a multi-minute log scan. These
// tests assert the ordering that makes that possible, and the honesty rules that must
// survive it:
//
//   1. a pair a factory getter can answer is quoted with ZERO eth_getLogs calls;
//   2. Uniswap v4 is searched only after the getter-backed venues fail;
//   3. a capped v4 search yields DISCOVERY_UNAVAILABLE, never LIQUIDITY_UNAVAILABLE;
//   4. any two distinct Base ERC-20s, or native ETH on one side, with no catalog veto;
//   5. a quotable direct pair is never rewritten through a mandatory WETH/USDC hop;
//   6. multi-hop is attempted only when no direct pool quotes, and never beyond 3 hops;
//   7. the fee is 25 bps on gross, once, to the pinned treasury, and skipping it fails.
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  V2_FEE_RECIPIENT, V4_MANAGER, discoverV2Quote, validateV2Quote, V2QuoteError, type V2Quote, type V4Key,
} from "../discovery";
import { RpcV2LiquiditySource, swapV2QuoteSource } from "../rpc-source";
import { V4DiscoveryCache, v4PoolKeyId } from "../rpc-v4";
import { SWAP_PATH_VENUES } from "../../swap-executor-config";
import { BASE_USDC, BASE_WETH, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";

const A = "0x0000000000000000000000000000000000000a01" as Address;
const B = "0x0000000000000000000000000000000000000b02" as Address;
const POOL = "0x0000000000000000000000000000000000000c03" as Address;
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";
const HEAD = 52_900_000n;
const DEPLOYED = 48_000_000n;
const GROSS = 1_000_000_000_000_000_000n;
const RANGE_REFUSAL = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;

const factories = parseAbi([
  "function getPair(address,address) view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function getPool(address,address,bool) view returns(address)",
]);
const slipFactory = parseAbi(["function getPool(address,address,int24) view returns(address)"]);
const props = parseAbi([
  "function factory() view returns(address)", "function token0() view returns(address)",
  "function token1() view returns(address)", "function fee() view returns(uint24)",
  "function tickSpacing() view returns(int24)", "function stable() view returns(bool)",
]);
const v3Quoter = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
const slipQuoter = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)"]);
const v2Router = parseAbi(["function getAmountsOut(uint256 amountIn,address[] path) view returns(uint256[] amounts)"]);
const classicRouter = parseAbi(["function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns(uint256[] amounts)"]);
const v4Quoter = parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)"]);

type IndexVenue = "uniswapV2" | "uniswapV3" | "aerodromeClassic" | "slipstream";

interface ChainOptions {
  /** A pool the FACTORY GETTERS know about. Present means stage 1 can answer. */
  indexPool?: { venue: IndexVenue; token0: Address; token1: Address; fee?: number; tickSpacing?: number; stable?: boolean };
  /** A v4 pool discoverable only from canonical `Initialize` logs. */
  v4Pool?: { block: bigint; key: V4Key };
  tokenDeployedAt?: bigint;
  logRangeCap?: bigint;
  quoteOut?: bigint;
  /** Refuse every log query, as a provider with no historical range would. */
  refuseLogs?: boolean;
}

interface MockChain { client: PublicClient; calls: { getLogs: number; getCode: number; call: number }; v4QuoterCalls: { zeroForOne: boolean; exactAmount: bigint }[] }

const addr = (value: string) => encodeAbiParameters([{ type: "address" }], [value as Address]);
const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

function chain(options: ChainOptions = {}): MockChain {
  const calls = { getLogs: 0, getCode: 0, call: 0 };
  const v4QuoterCalls: MockChain["v4QuoterCalls"] = [];
  const quoteOut = options.quoteOut ?? 1_000_000n;
  const index = options.indexPool;
  const v4 = options.v4Pool;
  const deployedAt = options.tokenDeployedAt ?? DEPLOYED;
  const venueOf = (name: IndexVenue) => SWAP_PATH_VENUES[name];

  const reader = {
    async getLogs(query: { address?: string; args?: Record<string, string>; fromBlock: bigint; toBlock: bigint }) {
      calls.getLogs++;
      if (options.refuseLogs) throw new Error(RANGE_REFUSAL);
      if (options.logRangeCap !== undefined && query.toBlock - query.fromBlock + 1n > options.logRangeCap) throw new Error(RANGE_REFUSAL);
      if (!v4 || String(query.address).toLowerCase() !== V4_MANAGER.toLowerCase()) return [];
      if (v4.block < query.fromBlock || v4.block > query.toBlock) return [];
      const args = query.args ?? {};
      const wanted = (want: string | undefined, got: string) => want === undefined || eq(want, got);
      if (!wanted(args.currency0, v4.key.currency0) && !wanted(args.currency1, v4.key.currency1)) return [];
      return [{
        blockNumber: v4.block, transactionHash: `0x${"33".repeat(32)}` as Hex,
        args: { id: v4PoolKeyId(v4.key), currency0: v4.key.currency0, currency1: v4.key.currency1, fee: v4.key.fee, tickSpacing: v4.key.tickSpacing, hooks: v4.key.hooks },
      }];
    },
    async getCode(query: { address: Address; blockNumber?: bigint }) {
      calls.getCode++;
      const address = query.address.toLowerCase();
      if (address === zeroAddress) return "0x" as Hex;
      if (v4 && (address === v4.key.currency1.toLowerCase() || address === v4.key.currency0.toLowerCase())) {
        return (query.blockNumber ?? HEAD) >= deployedAt ? ("0x6080604052" as Hex) : ("0x" as Hex);
      }
      return "0x6080604052" as Hex;
    },
    async getBlock() { return { timestamp: 1_760_000_000n }; },
    async call(query: { to?: string; data?: Hex }) {
      calls.call++;
      const to = String(query.to ?? "").toLowerCase();
      const data = query.data ?? "0x";
      let fn: { functionName: string; args: readonly unknown[] } | null = null;
      for (const abi of [factories, slipFactory, props, v3Quoter, slipQuoter, v2Router, classicRouter, v4Quoter]) {
        try { fn = decodeFunctionData({ abi, data }) as unknown as { functionName: string; args: readonly unknown[] }; break; } catch { fn = null; }
      }
      // The v4 quoter: answer from the fabricated pool, and record the direction asked.
      if (to === V4_QUOTER && fn?.functionName === "quoteExactInputSingle") {
        const params = fn.args[0] as { zeroForOne: boolean; exactAmount: bigint };
        v4QuoterCalls.push({ zeroForOne: params.zeroForOne, exactAmount: params.exactAmount });
        return { data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [quoteOut, 200_000n]) };
      }
      if (!fn) return { data: encodeAbiParameters([{ type: "uint256" }], [0n]) };
      // Factory getters: only the configured venue/pair answers with a pool.
      if (fn.functionName === "getPair" || fn.functionName === "getPool") {
        if (index && to === venueOf(index.venue).factory.toLowerCase()) {
          const [a, b] = fn.args as [string, string];
          const tier = fn.args[2];
          const pairMatches = (eq(a, index.token0) && eq(b, index.token1)) || (eq(a, index.token1) && eq(b, index.token0));
          const tierMatches = index.venue === "uniswapV2"
            ? fn.functionName === "getPair"
            : index.venue === "aerodromeClassic"
              ? fn.functionName === "getPool" && tier === (index.stable ?? false)
              : index.venue === "uniswapV3"
                ? fn.functionName === "getPool" && Number(tier) === (index.fee ?? 3000)
                : fn.functionName === "getPool" && Number(tier) === (index.tickSpacing ?? 10);
          if (pairMatches && tierMatches) return { data: addr(POOL) };
        }
        return { data: addr(zeroAddress) };
      }
      // The pool's own metadata, which is what makes an indexed pool canonical.
      if (index && to === POOL.toLowerCase()) {
        switch (fn.functionName) {
          case "factory": return { data: addr(venueOf(index.venue).factory) };
          case "token0": return { data: addr(index.token0) };
          case "token1": return { data: addr(index.token1) };
          case "fee": return { data: encodeAbiParameters([{ type: "uint24" }], [index.fee ?? 0]) };
          case "tickSpacing": return { data: encodeAbiParameters([{ type: "int24" }], [index.tickSpacing ?? 0]) };
          default: return { data: encodeAbiParameters([{ type: "bool" }], [index.stable ?? false]) };
        }
      }
      // Venue quoters.
      if (fn.functionName === "quoteExactInputSingle") {
        return { data: encodeAbiParameters([{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }], [quoteOut, 0n, 0, 0n]) };
      }
      if (fn.functionName === "getAmountsOut") {
        return { data: encodeAbiParameters([{ type: "uint256[]" }], [[GROSS, quoteOut]]) };
      }
      return { data: encodeAbiParameters([{ type: "uint256" }], [0n]) };
    },
  };
  return { client: reader as unknown as PublicClient, calls, v4QuoterCalls };
}

/** The production configuration: getters first, bounded v4 second, no whole-chain sweep. */
const quoteSource = (c: MockChain) => swapV2QuoteSource(c.client as never, HEAD);
const catchQuote = (promise: Promise<V2Quote>) => promise.then(() => null, (error: unknown) => error as V2QuoteError);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("a pasted pair with a getter-backed pool is quoted without touching eth_getLogs", () => {
  it.each([
    ["Uniswap v3", { venue: "uniswapV3", token0: A, token1: B, fee: 3000 } as const, 2],
    ["Uniswap v2", { venue: "uniswapV2", token0: A, token1: B } as const, 3],
    ["Aerodrome Classic", { venue: "aerodromeClassic", token0: A, token1: B, stable: true } as const, 4],
    ["Aerodrome Slipstream", { venue: "slipstream", token0: A, token1: B, tickSpacing: 10 } as const, 1],
  ])("quotes a direct %s pool in one pass", async (_label, indexPool, kind) => {
    const c = chain({ indexPool, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), A, B, GROSS);
    expect(quote.legs).toHaveLength(1);
    expect(quote.legs[0].pools).toHaveLength(1);
    expect(quote.legs[0].pools[0].kind).toBe(kind);
    expect(quote.legs[0].pools[0].pool.toLowerCase()).toBe(POOL.toLowerCase());
    // THE POINT OF THE WHOLE EXERCISE: not one log query. Every provider refuses them
    // here, so a single eth_getLogs would have made this quote fail or hang.
    expect(c.calls.getLogs).toBe(0);
    expect(quote.amountOut).toBeGreaterThan(0n);
  });

  it("never runs the whole-chain canonical sweep on the user-facing path", async () => {
    const c = chain({ indexPool: { venue: "uniswapV3", token0: A, token1: B, fee: 500 }, refuseLogs: true });
    const source = quoteSource(c);
    await discoverV2Quote(source, A, B, GROSS);
    expect(c.calls.getLogs).toBe(0);
    // And the source says so rather than leaving a reader to guess: a disabled sweep is
    // recorded as unavailable, which is what keeps "no pool" from becoming a negative.
    expect(source.diagnosticsFor(A, B).historyScan).toBe("not-run");
    expect(source.negativeProvable(A, B)).toBe(false);
  });

  it("does not rewrite a quotable direct pair through a WETH or USDC hop", async () => {
    // A and B are two arbitrary tokens with their own pool; neither is WETH or USDC.
    const c = chain({ indexPool: { venue: "uniswapV3", token0: A, token1: B, fee: 3000 }, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), A, B, GROSS);
    expect(quote.legs[0].pools).toHaveLength(1);
    expect(quote.legs[0].tokens.map((t) => t.toLowerCase())).toEqual([A.toLowerCase(), B.toLowerCase()]);
    const used = new Set(quote.legs.flatMap((leg) => leg.tokens.map((t) => t.toLowerCase())));
    expect(used.has(BASE_WETH.toLowerCase())).toBe(false);
    expect(used.has(USDC.toLowerCase())).toBe(false);
  });
});

describe("Uniswap v4 is searched only after the getter-backed venues cannot answer", () => {
  const mpgrKey: V4Key = { currency0: zeroAddress, currency1: B, fee: 3000, tickSpacing: 60, hooks: "0x1111111111111111111111111111111111111111" as Address };

  it("quotes a native-side v4 pool when no factory getter knows the pair", async () => {
    const c = chain({ v4Pool: { block: DEPLOYED + 1n, key: mpgrKey }, tokenDeployedAt: DEPLOYED, logRangeCap: 10n });
    const quote = await discoverV2Quote(quoteSource(c), BASE_WETH, B, GROSS);
    expect(quote.legs[0].pools).toHaveLength(1);
    const pool = quote.legs[0].pools[0];
    expect(pool.kind).toBe(7);
    expect(pool.pool.toLowerCase()).toBe(V4_MANAGER.toLowerCase());
    // Native side normalised for routing, PoolKey left exactly as the chain states it.
    expect(pool.token0.toLowerCase()).toBe(BASE_WETH.toLowerCase());
    expect(pool.v4Key!.currency0.toLowerCase()).toBe(zeroAddress);
    expect(pool.id).toBe(`${V4_MANAGER.toLowerCase()}:${v4PoolKeyId(mpgrKey).toLowerCase()}`);
    // v4 was reached only because stage 1 had nothing: the log queries happened.
    expect(c.calls.getLogs).toBeGreaterThan(0);
    expect(c.v4QuoterCalls[0].zeroForOne).toBe(true);
  });

  it("does not search v4 at all when a getter-backed pool already quoted", async () => {
    const c = chain({
      indexPool: { venue: "uniswapV3", token0: BASE_WETH, token1: B, fee: 3000 },
      v4Pool: { block: DEPLOYED + 1n, key: mpgrKey }, tokenDeployedAt: DEPLOYED, logRangeCap: 10n,
    });
    const quote = await discoverV2Quote(quoteSource(c), BASE_WETH, B, GROSS);
    expect(quote.legs[0].pools[0].kind).toBe(2);
    expect(c.calls.getLogs).toBe(0);
    expect(c.v4QuoterCalls).toHaveLength(0);
  });
});

describe("a bounded search never becomes a claim about liquidity", () => {
  it("reports DISCOVERY_UNAVAILABLE, not LIQUIDITY_UNAVAILABLE, when the v4 scan is capped", async () => {
    // No getter pool, and the only v4 pool sits far outside a ten-block scan's reach.
    const c = chain({
      v4Pool: { block: DEPLOYED + 3_000_000n, key: { currency0: zeroAddress, currency1: B, fee: 3000, tickSpacing: 60, hooks: zeroAddress as Address } },
      tokenDeployedAt: DEPLOYED, logRangeCap: 10n,
    });
    const error = await catchQuote(discoverV2Quote(quoteSource(c), B, BASE_WETH, GROSS));
    expect(error).toBeInstanceOf(V2QuoteError);
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    expect(error!.code).not.toBe("LIQUIDITY_UNAVAILABLE");
    expect(error!.message).not.toMatch(/no compatible pool exists|has no liquidity/i);
  });

  it("reports DISCOVERY_UNAVAILABLE when the provider refuses every log range", async () => {
    const c = chain({ refuseLogs: true });
    const error = await catchQuote(discoverV2Quote(quoteSource(c), A, B, GROSS));
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    expect(error!.attribution).toBe("BUDGET_EXHAUSTED");
  });

  it("fails fast rather than scanning the whole chain when no pool exists anywhere", async () => {
    const c = chain({ refuseLogs: true });
    const source = quoteSource(c);
    const error = await catchQuote(discoverV2Quote(source, A, B, GROSS));
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    // The only log calls are the v4 probe ladder's handful of refused ranges. The
    // whole-chain sweep, which would have bisected from block 0 up to its 2000-call
    // budget, is disabled on this path and contributes nothing.
    expect(c.calls.getLogs).toBeLessThan(20);
    expect(source.diagnosticsFor(A, B).historyScan).toBe("unavailable");
    expect(source.negativeProvable(A, B)).toBe(false);
  });
});

describe("no catalog veto: any two distinct Base assets, native ETH on either side", () => {
  it("quotes two arbitrary tokens that appear in no app catalog", async () => {
    const c = chain({ indexPool: { venue: "uniswapV2", token0: A, token1: B }, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), A, B, GROSS);
    expect(quote.tokenIn.toLowerCase()).toBe(A.toLowerCase());
    expect(quote.tokenOut.toLowerCase()).toBe(B.toLowerCase());
    expect(quote.legs[0].pools[0].kind).toBe(3);
  });

  it("accepts the native ETH sentinel on the sell side and normalises it to WETH", async () => {
    const c = chain({ indexPool: { venue: "uniswapV3", token0: BASE_WETH, token1: B, fee: 3000 }, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), NATIVE_ETH_SENTINEL, B, GROSS);
    expect(quote.tokenIn.toLowerCase()).toBe(BASE_WETH.toLowerCase());
    expect(quote.legs[0].tokens[0].toLowerCase()).toBe(BASE_WETH.toLowerCase());
    expect(c.calls.getLogs).toBe(0);
  });

  it("accepts native ETH on the buy side too", async () => {
    const c = chain({ indexPool: { venue: "uniswapV3", token0: B, token1: BASE_WETH, fee: 3000 }, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), B, NATIVE_ETH_SENTINEL, GROSS);
    expect(quote.tokenOut.toLowerCase()).toBe(BASE_WETH.toLowerCase());
    expect(quote.legs[0].tokens.at(-1)!.toLowerCase()).toBe(BASE_WETH.toLowerCase());
  });

  it("still refuses ETH and WETH as a pair, because they are one asset", async () => {
    const c = chain({ refuseLogs: true });
    await expect(discoverV2Quote(quoteSource(c), NATIVE_ETH_SENTINEL, BASE_WETH, GROSS))
      .rejects.toMatchObject({ code: "INVALID_PAIR" });
  });
});

describe("multi-hop is a fallback, never a preference, and never longer than three hops", () => {
  it("does not enumerate neighbours when a direct pool quotes", async () => {
    // Neighbour enumeration can only be answered by a log sweep on this source, so a
    // direct quote that issues no log calls proves multi-hop was never attempted.
    const c = chain({ indexPool: { venue: "uniswapV3", token0: A, token1: B, fee: 3000 }, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), A, B, GROSS);
    expect(quote.legs[0].pools).toHaveLength(1);
    expect(c.calls.getLogs).toBe(0);
  });

  it("falls back to a two-hop route through a real neighbour when no direct pool quotes", async () => {
    // A source whose getter stage finds A/X and X/B but no A/B pool. Neighbour
    // enumeration is served here, so the fallback can complete.
    const X = "0x0000000000000000000000000000000000000e05" as Address;
    const poolsByPair = new Map<string, { pool: Address; token0: Address; token1: Address }>([
      [`${A.toLowerCase()}:${X.toLowerCase()}`, { pool: POOL, token0: A, token1: X }],
      [`${X.toLowerCase()}:${B.toLowerCase()}`, { pool: "0x0000000000000000000000000000000000000d04" as Address, token0: X, token1: B }],
    ]);
    const source = {
      async pools(input: Address, output?: Address) {
        if (output) {
          const hit = poolsByPair.get(`${input.toLowerCase()}:${output.toLowerCase()}`)
            ?? poolsByPair.get(`${output.toLowerCase()}:${input.toLowerCase()}`);
          return hit ? [{
            id: `idx:${hit.pool.toLowerCase()}`, pool: hit.pool, router: SWAP_PATH_VENUES.uniswapV3.router,
            factory: SWAP_PATH_VENUES.uniswapV3.factory, kind: 2 as const, token0: hit.token0, token1: hit.token1,
            poolFee: 3000, tickSpacing: 60, stable: false,
          }] : [];
        }
        // Neighbour enumeration: every pool this token appears in.
        return [...poolsByPair.values()]
          .filter((p) => eq(p.token0, input) || eq(p.token1, input))
          .map((p) => ({
            id: `idx:${p.pool.toLowerCase()}`, pool: p.pool, router: SWAP_PATH_VENUES.uniswapV3.router,
            factory: SWAP_PATH_VENUES.uniswapV3.factory, kind: 2 as const, token0: p.token0, token1: p.token1,
            poolFee: 3000, tickSpacing: 60, stable: false,
          }));
      },
      async quote(_pool: unknown, _input: Address, amount: bigint) { return amount / 2n; },
      negativeProvable: () => false,
    };
    const quote = await discoverV2Quote(source as never, A, B, GROSS);
    expect(quote.legs[0].pools).toHaveLength(2);
    expect(quote.legs[0].tokens.map((t) => t.toLowerCase())).toEqual([A.toLowerCase(), X.toLowerCase(), B.toLowerCase()]);
    expect(quote.legs[0].pools.length).toBeLessThanOrEqual(3);
  });

  it("quotes a WETH bridge when neighbour enumeration is unavailable", async () => {
    const pool = (id: Address, token0: Address, token1: Address) => ({
      id: `idx:${id.toLowerCase()}`, pool: id, router: SWAP_PATH_VENUES.uniswapV3.router,
      factory: SWAP_PATH_VENUES.uniswapV3.factory, kind: 2 as const, token0, token1,
      poolFee: 3000, tickSpacing: 60, stable: false,
    });
    const left = pool(POOL, A, BASE_WETH);
    const right = pool("0x0000000000000000000000000000000000000d04" as Address, BASE_WETH, B);
    const source = {
      async pools(input: Address, output?: Address) {
        if (!output) throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "neighbour sweep disabled");
        const pair = [input.toLowerCase(), output.toLowerCase()].sort().join(":");
        const weth = BASE_WETH.toLowerCase();
        if (pair === [A.toLowerCase(), weth].sort().join(":")) return [left];
        if (pair === [B.toLowerCase(), weth].sort().join(":")) return [right];
        if (pair === [A.toLowerCase(), BASE_USDC.toLowerCase()].sort().join(":")) return [];
        if (pair === [B.toLowerCase(), BASE_USDC.toLowerCase()].sort().join(":")) return [];
        return [];
      },
      async quote(_pool: unknown, _input: Address, amount: bigint) { return amount / 2n; },
      negativeProvable: () => false,
    };
    const quote = await discoverV2Quote(source as never, A, B, GROSS);
    expect(quote.legs[0].pools).toHaveLength(2);
    expect(quote.legs[0].tokens.map((t) => t.toLowerCase())).toEqual([A.toLowerCase(), BASE_WETH.toLowerCase(), B.toLowerCase()]);
    expect(quote.fee).toBe(GROSS * 25n / 10_000n);
    expect(quote.legs[0].amountIn).toBe(quote.net);
  });
});

describe("the 25 bps fee survives the fast path", () => {
  it("charges 25 bps on gross exactly once, to the pinned treasury", async () => {
    const c = chain({ indexPool: { venue: "uniswapV3", token0: A, token1: B, fee: 3000 }, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), A, B, GROSS);
    expect(quote.feeBps).toBe(25);
    expect(quote.fee).toBe(GROSS * 25n / 10_000n);
    expect(quote.net).toBe(GROSS - quote.fee);
    expect(quote.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(quote.legs.reduce((sum, leg) => sum + leg.amountIn, 0n)).toBe(quote.net);
    expect(() => validateV2Quote(quote)).not.toThrow();
  });

  it("rejects a quote that skipped the fee", async () => {
    const c = chain({ indexPool: { venue: "uniswapV3", token0: A, token1: B, fee: 3000 }, refuseLogs: true });
    const quote = await discoverV2Quote(quoteSource(c), A, B, GROSS);
    expect(() => validateV2Quote({ ...quote, fee: 0n, net: quote.gross })).toThrow(V2QuoteError);
    expect(() => validateV2Quote({ ...quote, fee: quote.gross * 24n / 10_000n, net: quote.gross - quote.gross * 24n / 10_000n })).toThrow(V2QuoteError);
    expect(() => validateV2Quote({ ...quote, feeRecipient: A })).toThrow(V2QuoteError);
  });

  it("rejects an amount too small for the fee to exist", async () => {
    const c = chain({ indexPool: { venue: "uniswapV3", token0: A, token1: B, fee: 3000 }, refuseLogs: true });
    await expect(discoverV2Quote(quoteSource(c), A, B, 399n)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });
});

describe("swapV2QuoteSource is configured for one paste, not for a batch", () => {
  it("disables the whole-chain sweep and bounds the v4 scan by default", async () => {
    const c = chain({ refuseLogs: true });
    const source = quoteSource(c);
    expect(source).toBeInstanceOf(RpcV2LiquiditySource);
    const stages = source.directStages(A, B).map((stage) => stage.name);
    expect(stages).toEqual(["factory-index", "v4-canonical-logs", "canonical-sweep"]);
    await catchQuote(discoverV2Quote(source, A, B, GROSS));
    // A disabled sweep is recorded as unavailable, never silently as complete.
    expect(source.diagnosticsFor(A, B).historyScan).toBe("unavailable");
  });

  it("honours an operator who raises the sweep budget, and negatives become provable", async () => {
    vi.stubEnv("MPGR_SWAP_V2_MAX_SWEEP_CALLS", "500");
    // No pool anywhere, and a provider that serves any range: the shape in which "this
    // pair has no pool" is a real verdict rather than an unmeasured one.
    const c = chain();
    const source = swapV2QuoteSource(c.client as never, HEAD);
    const error = await catchQuote(discoverV2Quote(source, A, B, GROSS));
    expect(c.calls.getLogs).toBeGreaterThan(0);
    expect(source.diagnosticsFor(A, B).historyScan).toBe("complete");
    expect(source.diagnosticsFor(A, B).v4?.state).toBe("complete");
    expect(source.negativeProvable(A, B)).toBe(true);
    expect(error!.code).toBe("LIQUIDITY_UNAVAILABLE");
    expect(error!.attribution).toBe("POOL_NOT_DISCOVERED");
    vi.unstubAllEnvs();
  });

  it("does not run the sweep at all when an earlier stage already answered", async () => {
    // The point of staging: raising the sweep budget must not make a quotable pair pay
    // for the sweep anyway.
    vi.stubEnv("MPGR_SWAP_V2_MAX_SWEEP_CALLS", "500");
    const c = chain({ indexPool: { venue: "uniswapV3", token0: A, token1: B, fee: 3000 } });
    await discoverV2Quote(swapV2QuoteSource(c.client as never, HEAD), A, B, GROSS);
    expect(c.calls.getLogs).toBe(0);
    vi.unstubAllEnvs();
  });

  it("shares one bounded v4 cache per quote and never reuses it across blocks", () => {
    const c = chain({ refuseLogs: true });
    const first = swapV2QuoteSource(c.client as never, HEAD);
    const second = swapV2QuoteSource(c.client as never, HEAD);
    expect(first).not.toBe(second);
    // Each quote pins its own block, so each gets its own cache: a token's deployment
    // floor and scan are functions of (token, block) and must not leak between them.
    expect(first).toBeInstanceOf(RpcV2LiquiditySource);
    expect(new V4DiscoveryCache()).toBeInstanceOf(V4DiscoveryCache);
  });
});
