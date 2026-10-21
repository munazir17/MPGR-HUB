// lib/swap/v2/__tests__/mpgr-direction-attribution.test.ts
//
// WHY THIS FILE EXISTS. The coverage matrix measured `BUY WETH -> MPGR` as an
// EXECUTABLE_ROUTE through a Uniswap v4 pool whose currency0 is the zero address,
// while `SELL MPGR -> WETH` — the SAME pool, opposite direction — came back as an
// undifferentiated UNMEASURED_PROVIDER_FAILURE whose reason text came from the
// multi-hop fallback. Those two facts cannot both be about liquidity, and the code
// could not say which of five things had actually happened:
//
//   1. no v4 pool was discovered at all
//   2. a pool was discovered but the venue quote failed or reverted
//   3. a hook or the token's own transfer rules rejected the swap
//   4. a pool was discovered but the deployed executor could not address it
//   5. a read/log/wall-clock budget ran out before the venue was asked
//
// Every one of those used to collapse into the same silent `null` from `quoteLeg`, so
// the pair was reported as "provider failure" regardless. These tests pin the
// attribution down for both directions of an MPGR-shaped pair.
//
// EVIDENCE TIER — SIMULATED. The chain below is a fabricated in-process reader with a
// fabricated PoolKey. Nothing here contacted Base. The pool parameters are deliberately
// NOT MPGR's real ones (fee 3000, tickSpacing 60, a made-up hooks address, a made-up
// deployment block) so that no real pool id, hook, fee, tick spacing or block number is
// encoded as an expected result anywhere: discovery has to derive all of it from the
// fabricated `Initialize` log, exactly as it does on chain. Real Base evidence for this
// pair lives in the coverage-matrix workflow, not here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  V2_FEE_BPS, V2_FEE_RECIPIENT, V4_MANAGER, attributeRouteFailure, discoverV2Quote, poolRejection,
  validateV2Quote, V2QuoteError, type CandidateOutcome, type LiquiditySource, type Pool, type RouteAttemptTrace, type V4Key,
} from "../discovery";
import { RpcV2LiquiditySource } from "../rpc-source";
import { v4PoolKeyId, V4DiscoveryCache } from "../rpc-v4";
import { classifyPairOutcome, ATTRIBUTION_LABELS } from "../coverage";
import { BASE_WETH, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";

const WETH = BASE_WETH;
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";
/** The subject: a token imported by address, in no app catalog, whose only liquidity is
 * a v4 pool against native ETH. Its address is public input, not an expected output. */
const TOKEN = "0xb2000000000000000000008d204203177a78af01" as Address;
/** Fabricated pool parameters. Deliberately unlike the real pool's (fee 0, spacing 200)
 * so nothing real can be smuggled in as a fixture and mistaken for a derived result. */
const HOOKS = "0x1111111111111111111111111111111111111111" as Address;
const NO_HOOKS = zeroAddress as Address;
const FEE = 3000;
const TICK_SPACING = 60;
const HEAD = 52_000_000n;
const DEPLOYED = 48_000_000n;
const nativeKey = (hooks: Address = HOOKS): V4Key =>
  ({ currency0: zeroAddress, currency1: TOKEN, fee: FEE, tickSpacing: TICK_SPACING, hooks });
const RANGE_REFUSAL = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.";
const GROSS = 1_000_000_000_000_000_000n;

type QuoterVerdict =
  | { mode: "amount"; amountOut: bigint }
  | { mode: "revert"; reason: string }
  | { mode: "rpc-error"; reason: string };

interface ChainOptions {
  /** Where the fabricated Initialize log sits. */
  poolBlock?: bigint;
  hooks?: Address;
  /** Refuse any eth_getLogs range wider than this, like the free-tier provider the
   * coverage matrix actually runs against. Omit for a provider that serves any range. */
  logRangeCap?: bigint;
  /** Decides what the v4 quoter does, given the direction it was asked about. */
  quoter?: (params: { zeroForOne: boolean; exactAmount: bigint; poolKey: V4Key }) => QuoterVerdict;
}

interface MockChain {
  client: PublicClient;
  calls: { getLogs: number; getCode: number; call: number };
  quoterCalls: { zeroForOne: boolean; exactAmount: bigint; poolKey: V4Key }[];
}

const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)",
]);

function chain(options: ChainOptions = {}): MockChain {
  const poolBlock = options.poolBlock ?? DEPLOYED + 1n;
  const key = nativeKey(options.hooks ?? HOOKS);
  const calls = { getLogs: 0, getCode: 0, call: 0 };
  const quoterCalls: MockChain["quoterCalls"] = [];
  const verdict = options.quoter ?? (() => ({ mode: "amount", amountOut: 7_000_000n } as QuoterVerdict));

  const reader = {
    async getLogs(query: { address?: string; args?: Record<string, string>; fromBlock: bigint; toBlock: bigint }) {
      calls.getLogs++;
      if (options.logRangeCap !== undefined && query.toBlock - query.fromBlock + 1n > options.logRangeCap) throw new Error(RANGE_REFUSAL);
      if (String(query.address).toLowerCase() !== V4_MANAGER.toLowerCase()) return [];
      if (poolBlock < query.fromBlock || poolBlock > query.toBlock) return [];
      const args = query.args ?? {};
      const matches = (want: string | undefined, got: string) => want === undefined || want.toLowerCase() === got.toLowerCase();
      if (!matches(args.currency0, key.currency0) && !matches(args.currency1, key.currency1)) return [];
      return [{
        blockNumber: poolBlock,
        transactionHash: `0x${"22".repeat(32)}` as Hex,
        args: { id: v4PoolKeyId(key), currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks },
      }];
    },
    async getCode(query: { address: Address; blockNumber?: bigint }) {
      calls.getCode++;
      const address = query.address.toLowerCase();
      if (address === zeroAddress) return "0x" as Hex;
      if (address === TOKEN.toLowerCase()) return (query.blockNumber ?? HEAD) >= DEPLOYED ? ("0x6080604052" as Hex) : ("0x" as Hex);
      return "0x6080604052" as Hex; // WETH, the PoolManager and the quoter are predeploy-like
    },
    async getBlock() { return { timestamp: 1_760_000_000n }; },
    async call(query: { to?: string; data?: Hex }) {
      calls.call++;
      if (String(query.to ?? "").toLowerCase() === V4_QUOTER) {
        const decoded = decodeFunctionData({ abi: quoterAbi, data: query.data ?? "0x" }) as unknown as { args: [{ poolKey: V4Key; zeroForOne: boolean; exactAmount: bigint }] };
        const params = decoded.args[0];
        quoterCalls.push({ zeroForOne: params.zeroForOne, exactAmount: params.exactAmount, poolKey: params.poolKey });
        const result = verdict(params);
        if (result.mode === "revert") throw new Error(`Execution reverted: ${result.reason}`);
        if (result.mode === "rpc-error") throw new Error(result.reason);
        return { data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [result.amountOut, 200_000n]) };
      }
      // Every canonical factory getter answers "no such pool", so the bounded index
      // contributes nothing and the v4 search is what is actually under test.
      return { data: encodeAbiParameters([{ type: "address" }], [zeroAddress]) };
    },
  };
  return { client: reader as unknown as PublicClient, calls, quoterCalls };
}

/** The real production source, pinned to a fabricated block, sharing one v4 cache the
 * way the coverage matrix does. `maxSweepCalls` is a parameter because a complete
 * negative verdict is only allowed when the sweep actually ran. */
function source(c: MockChain, opts: { maxSweepCalls?: number; maxReads?: number; cache?: V4DiscoveryCache } = {}) {
  return new RpcV2LiquiditySource(
    c.client as never, HEAD, opts.maxReads ?? 4096, opts.maxSweepCalls ?? 0,
    { cache: opts.cache ?? new V4DiscoveryCache() },
  );
}

const traceOf = (error: unknown): RouteAttemptTrace => {
  expect(error).toBeInstanceOf(V2QuoteError);
  const trace = (error as V2QuoteError).trace;
  expect(trace, "a routing failure must carry the trace that explains it").toBeDefined();
  return trace!;
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("WETH -> MPGR BUY: the native-side v4 pool is a WETH route", () => {
  it("quotes an executable one-leg route with the 25 bps fee intact", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({ logRangeCap: 10n });
    const quote = await discoverV2Quote(source(c), WETH, TOKEN, GROSS);

    expect(quote.legs).toHaveLength(1);
    expect(quote.legs[0].pools).toHaveLength(1);
    const pool = quote.legs[0].pools[0];
    expect(pool.kind).toBe(7);
    expect(pool.pool.toLowerCase()).toBe(V4_MANAGER.toLowerCase());

    // NATIVE <-> WETH NORMALISATION, asserted from both sides at once: the PoolKey keeps
    // the zero address as currency0 (that is what the PoolManager indexes and what the
    // executor's hop calldata must carry), while the pool's routing tokens read as
    // canonical WETH (that is what makes it a WETH route at all).
    expect(pool.v4Key!.currency0.toLowerCase()).toBe(zeroAddress);
    expect(pool.v4Key!.currency1.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(pool.token0.toLowerCase()).toBe(WETH.toLowerCase());
    expect(pool.token1.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(poolRejection(pool)).toBeNull();

    // The PoolKey was DERIVED from the fabricated log, not read from this file.
    expect(v4PoolKeyId(pool.v4Key!)).toBe(v4PoolKeyId({ ...pool.v4Key! }));
    expect(c.quoterCalls).toHaveLength(1);
    expect(c.quoterCalls[0].zeroForOne).toBe(true); // currency0 (native) -> currency1 (token)
    expect(c.quoterCalls[0].poolKey.hooks.toLowerCase()).toBe(HOOKS.toLowerCase());

    // FEE INVARIANT: 25 bps on GROSS, computed exactly once, recipient pinned.
    expect(V2_FEE_BPS).toBe(25);
    expect(quote.feeBps).toBe(25);
    expect(quote.fee).toBe(GROSS * 25n / 10_000n);
    expect(quote.net).toBe(GROSS - quote.fee);
    expect(quote.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(quote.legs.reduce((sum, leg) => sum + leg.amountIn, 0n)).toBe(quote.net);
    expect(quote.amountOut).toBe(quote.legs.reduce((sum, leg) => sum + leg.amountOut, 0n));
    expect(() => validateV2Quote(quote)).not.toThrow();
  });

  it("routes the native ETH sentinel to the same pool as WETH", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({ logRangeCap: 10n });
    const viaSentinel = await discoverV2Quote(source(c), NATIVE_ETH_SENTINEL, TOKEN, GROSS);
    expect(viaSentinel.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
    expect(viaSentinel.legs[0].pools[0].v4Key!.currency0.toLowerCase()).toBe(zeroAddress);
    expect(viaSentinel.amountOut).toBeGreaterThan(0n);
    expect(() => validateV2Quote(viaSentinel)).not.toThrow();
  });

  it("still refuses ETH and WETH as a pair, since they are one asset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(discoverV2Quote(source(chain()), NATIVE_ETH_SENTINEL, WETH, GROSS))
      .rejects.toMatchObject({ code: "INVALID_PAIR" });
  });
});

describe("MPGR -> WETH SELL: the same pool, attributed instead of guessed", () => {
  it("a reverting v4 quote is attributed to the hook or the token, and is NOT missing liquidity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({
      logRangeCap: 10n,
      quoter: ({ zeroForOne }) => (zeroForOne
        ? { mode: "amount", amountOut: 7_000_000n }
        : { mode: "revert", reason: "Hook refused the swap" }),
    });
    const error = await discoverV2Quote(source(c), TOKEN, WETH, GROSS).then(
      () => null, (caught: unknown) => caught as V2QuoteError);
    expect(error, "the SELL direction must fail on this fabricated chain").not.toBeNull();

    // The direction really was asked about correctly: selling the token is
    // currency1 -> currency0 on a pool whose currency0 is native.
    expect(c.quoterCalls.some((call) => call.zeroForOne === false)).toBe(true);

    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    expect(error!.attribution).toBe("HOOK_OR_TOKEN_INCOMPATIBLE");
    expect(error!.message).toMatch(/WAS discovered/i);
    expect(error!.message).toMatch(/REVERTED/);
    expect(error!.message).toMatch(/Hook refused the swap/);
    expect(error!.message).toMatch(/hooks contract in its call path/i);

    const trace = traceOf(error);
    expect(trace.candidates).toHaveLength(1);
    expect(trace.candidates[0].kind).toBe(7);
    expect(trace.candidates[0].hooks?.toLowerCase()).toBe(HOOKS.toLowerCase());
    expect(trace.candidates[0].outcome).toMatchObject({ cause: "reverted" });
    // A capped scan cannot prove absence, so this stays unmeasured.
    expect(trace.negativeProvable).toBe(false);
    expect(trace.notes.join(" ")).toMatch(/v4 Initialize search capped/);

    // And the coverage row says UNMEASURED, carrying the attribution and the scope.
    const row = classifyPairOutcome(TOKEN, WETH, { ok: false, error: error! });
    expect(row.category).toBe("UNMEASURED_PROVIDER_FAILURE");
    expect(row.measured).toBe(false);
    expect(row.attribution).toBe("HOOK_OR_TOKEN_INCOMPATIBLE");
    expect(row.evidenceScope).toMatch(/1 quotable candidate\(s\) \[reverted\]/);
    expect(ATTRIBUTION_LABELS[row.attribution!]).toMatch(/hook or token transfer rule/i);
  });

  it("a revert on a pool with NO hooks is attributed to the venue, not to a hook", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({
      hooks: NO_HOOKS, logRangeCap: 10n,
      quoter: ({ zeroForOne }) => (zeroForOne ? { mode: "amount", amountOut: 1n } : { mode: "revert", reason: "ST" }),
    });
    const error = await discoverV2Quote(source(c), TOKEN, WETH, GROSS).then(
      () => null, (caught: unknown) => caught as V2QuoteError);
    expect(error!.attribution).toBe("VENUE_REJECTED_SWAP");
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    expect(error!.message).not.toMatch(/hooks contract in its call path/i);
    expect(traceOf(error).candidates[0].hooks?.toLowerCase()).toBe(zeroAddress);
  });

  it("a zero answer on an incomplete search stays UNMEASURED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({ logRangeCap: 10n, quoter: () => ({ mode: "amount", amountOut: 0n }) });
    const error = await discoverV2Quote(source(c), TOKEN, WETH, GROSS).then(
      () => null, (caught: unknown) => caught as V2QuoteError);
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    expect(error!.attribution).toBe("QUOTE_ZERO_OUTPUT");
    expect(error!.message).toMatch(/none quoted a positive output/i);
    expect(error!.message).toMatch(/UNMEASURED, not missing liquidity/);
    const trace = traceOf(error);
    expect(trace.candidates[0].outcome).toEqual({ cause: "zero-output" });
    expect(trace.negativeProvable).toBe(false);
    expect(classifyPairOutcome(TOKEN, WETH, { ok: false, error: error! }).category).toBe("UNMEASURED_PROVIDER_FAILURE");
  });

  it("a zero answer on a COMPLETE search is missing liquidity, and says which pool answered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    // No log-range cap and a real sweep budget: the scan reaches the pinned block and the
    // canonical sweep completes, so a negative is finally provable.
    const c = chain({ quoter: () => ({ mode: "amount", amountOut: 0n }) });
    const src = source(c, { maxSweepCalls: 500 });
    const error = await discoverV2Quote(src, TOKEN, WETH, GROSS).then(
      () => null, (caught: unknown) => caught as V2QuoteError);
    expect(error!.code).toBe("LIQUIDITY_UNAVAILABLE");
    expect(error!.attribution).toBe("QUOTE_ZERO_OUTPUT");
    const trace = traceOf(error);
    expect(trace.negativeProvable).toBe(true);
    expect(src.negativeProvable(TOKEN, WETH)).toBe(true);
    expect(trace.notes.join(" ")).toMatch(/canonical event sweep complete/);
    const row = classifyPairOutcome(TOKEN, WETH, { ok: false, error: error! });
    expect(row.category).toBe("MISSING_LIQUIDITY");
    expect(row.measured).toBe(true);
  });

  it("a provider error while quoting is a provider failure, never a liquidity verdict", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({
      logRangeCap: 10n,
      quoter: ({ zeroForOne }) => (zeroForOne ? { mode: "amount", amountOut: 1n } : { mode: "rpc-error", reason: "HTTP request failed.\n\nStatus: 429" }),
    });
    const error = await discoverV2Quote(source(c), TOKEN, WETH, GROSS).then(
      () => null, (caught: unknown) => caught as V2QuoteError);
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    expect(error!.attribution).toBe("QUOTE_RPC_FAILED");
    expect(error!.message).toMatch(/429/);
    expect(traceOf(error).candidates[0].outcome).toMatchObject({ cause: "rpc-error" });
  });

  it("a pool the bounded scan cannot reach is the search's failure, not the pair's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    // The pool is initialized 3M blocks AFTER the token's deployment block. On a
    // ten-block provider a bounded scan cannot get there, so discovery throws rather
    // than claim a negative it cannot prove.
    const c = chain({ logRangeCap: 10n, poolBlock: DEPLOYED + 3_000_000n });
    const error = await discoverV2Quote(source(c), TOKEN, WETH, GROSS).then(
      () => null, (caught: unknown) => caught as V2QuoteError);
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    // Attributed to the search being cut short — which is the truth — and NOT to the
    // pair lacking a pool, which nobody established.
    expect(error!.attribution).toBe("BUDGET_EXHAUSTED");
    expect(error!.message).toMatch(/could not finish/i);
    const trace = traceOf(error);
    // Staged discovery reports this through the trace's notes instead of the union gate,
    // and the notes carry strictly more: what each stage could establish, including what
    // BOTH sides of the v4 scan reached before the budget ran out, so the uncovered
    // middle is named rather than implied.
    const notes = trace.notes.join(" ");
    expect(notes).toMatch(/v4 Initialize search capped/);
    expect(notes).toMatch(/stopped at \d+-\d+ forward and \d+-\d+ backward of \d+/);
    expect(notes).toMatch(/exceeded its \d+-call budget/);
    expect(notes).toMatch(/canonical event sweep unavailable/);
    // The stages that ran, in order, are part of the evidence: getters first, v4 second,
    // and no whole-chain sweep because this source has it disabled.
    expect(trace.stages.map((stage) => stage.name)).toEqual(["factory-index", "v4-canonical-logs", "canonical-sweep"]);
    expect(trace.stages.every((stage) => stage.complete === false)).toBe(true);
    // Multi-hop could not rescue it either, and that is recorded rather than masking the
    // direct attempt.
    expect(trace.multihop.note).toMatch(/neighbour enumeration|historical log range/i);
    expect(trace.candidates).toHaveLength(0);
    expect(trace.negativeProvable).toBe(false);
    expect(classifyPairOutcome(TOKEN, WETH, { ok: false, error: error! }).category).toBe("UNMEASURED_PROVIDER_FAILURE");
  });

  it("an exhausted read budget is attributed to the budget, not to the chain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({ logRangeCap: 10n });
    const error = await discoverV2Quote(source(c, { maxReads: 2 }), TOKEN, WETH, GROSS).then(
      () => null, (caught: unknown) => caught as V2QuoteError);
    expect(error).toBeInstanceOf(V2QuoteError);
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    expect(error!.message).toMatch(/budget/i);
    // Whatever the shape of the failure, it is never reported as missing liquidity.
    expect(classifyPairOutcome(TOKEN, WETH, { ok: false, error: error! }).category).toBe("UNMEASURED_PROVIDER_FAILURE");
  });
});

describe("attribution is per candidate, so one venue cannot erase another", () => {
  const pool = (over: Partial<Pool> = {}): Pool => ({
    id: "pool-a", pool: "0xaaaa000000000000000000000000000000000001" as Address,
    router: "0xaaaa000000000000000000000000000000000002" as Address,
    factory: "0xaaaa000000000000000000000000000000000003" as Address,
    kind: 1, token0: WETH, token1: TOKEN, poolFee: 0, tickSpacing: 10, stable: false, ...over,
  });

  it("records an outage on one pool and still routes through the one that quoted", async () => {
    const outcomes = new Map<string, CandidateOutcome>([
      ["pool-a", { cause: "rpc-error", detail: "socket hang up" }],
      ["pool-b", { cause: "quoted", amountOut: 4_200n }],
    ]);
    const seen: string[] = [];
    const src: LiquiditySource = {
      async pools() { return [pool(), pool({ id: "pool-b", tickSpacing: 100 })]; },
      async quote(p) { return outcomes.get(p.id)!.cause === "quoted" ? 4_200n : 0n; },
      async quoteAttempt(p) { seen.push(p.id); return outcomes.get(p.id)!; },
      negativeProvable: () => false,
    };
    const quote = await discoverV2Quote(src, WETH, TOKEN, GROSS);
    expect(quote.amountOut).toBe(4_200n);
    expect(quote.legs[0].pools[0].id).toBe("pool-b");
    expect(seen.sort()).toEqual(["pool-a", "pool-b"]);
  });

  it("keeps every candidate's outcome when none of them quotes", async () => {
    const src: LiquiditySource = {
      async pools() { return [pool(), pool({ id: "pool-b", tickSpacing: 100 })]; },
      async quote() { return 0n; },
      async quoteAttempt(p) {
        return p.id === "pool-a" ? { cause: "reverted", detail: "ST" } : { cause: "zero-output" };
      },
      negativeProvable: () => false,
    };
    const error = await discoverV2Quote(src, WETH, TOKEN, GROSS).then(() => null, (e: unknown) => e as V2QuoteError);
    const trace = traceOf(error);
    expect(trace.candidates.map((c) => c.outcome.cause).sort()).toEqual(["reverted", "zero-output"]);
    // A revert outranks a zero: a refusal is not a fact about liquidity.
    expect(error!.attribution).toBe("VENUE_REJECTED_SWAP");
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
  });

  it("attributes a pool the deployed executor could not address", async () => {
    const src: LiquiditySource = {
      async pools() {
        return [
          pool({ id: "disabled-venue", kind: 5 as unknown as Pool["kind"] }),
          pool({
            id: "bad-v4", kind: 7, pool: V4_MANAGER, router: V4_MANAGER, factory: V4_MANAGER,
            // token0 does not match its own PoolKey: unreachable by the executor.
            v4Key: { currency0: zeroAddress, currency1: TOKEN, fee: FEE, tickSpacing: TICK_SPACING, hooks: HOOKS },
            token0: TOKEN, token1: WETH,
          }),
        ];
      },
      async quote() { return 0n; },
      negativeProvable: () => false,
    };
    const error = await discoverV2Quote(src, WETH, TOKEN, GROSS).then(() => null, (e: unknown) => e as V2QuoteError);
    expect(error!.attribution).toBe("EXECUTOR_VALIDATION_REJECTED");
    expect(error!.code).toBe("DISCOVERY_UNAVAILABLE");
    const trace = traceOf(error);
    expect(trace.candidates).toHaveLength(0);
    expect(trace.rejected.map((r) => r.cause).sort()).toEqual(["v4-key-mismatch", "venue-kind-not-enabled"]);
    expect(error!.message).toMatch(/could not address/i);
  });

  it("treats a pool that does not connect the pair as not discovered, not as rejected", async () => {
    const src: LiquiditySource = {
      async pools() { return [pool({ id: "elsewhere", token0: WETH, token1: "0xcccc000000000000000000000000000000000009" as Address })]; },
      async quote() { return 0n; },
      negativeProvable: () => true,
    };
    const error = await discoverV2Quote(src, WETH, TOKEN, GROSS).then(() => null, (e: unknown) => e as V2QuoteError);
    expect(error!.attribution).toBe("POOL_NOT_DISCOVERED");
    // A complete search that found nothing connecting the pair IS a liquidity verdict.
    expect(error!.code).toBe("LIQUIDITY_UNAVAILABLE");
    expect(traceOf(error).rejected.map((r) => r.cause)).toEqual(["does-not-connect-pair"]);
  });
});

describe("fee invariant on a split route", () => {
  it("charges 25 bps on gross exactly once across both legs", async () => {
    const v4 = (id: string, fee: number, tickSpacing: number): Pool => ({
      id, pool: V4_MANAGER, router: V4_MANAGER, factory: V4_MANAGER, kind: 7,
      token0: WETH, token1: TOKEN, poolFee: 0, tickSpacing: 0, stable: false,
      v4Key: { currency0: zeroAddress, currency1: TOKEN, fee, tickSpacing, hooks: HOOKS },
    });
    const net = GROSS - GROSS * 25n / 10_000n;
    // Capacity-limited pools: each returns 4x but saturates at half the input, so a
    // split genuinely beats either pool alone and the split path is exercised.
    const quoteOne = (amount: bigint) => (amount > net / 2n ? net / 2n : amount) * 4n;
    const src: LiquiditySource = {
      async pools() { return [v4("pool-a", FEE, TICK_SPACING), v4("pool-b", 500, 10)]; },
      async quote(_pool, _input, amount) { return quoteOne(amount); },
      async quoteAttempt(pool, _input, amount) { return { cause: "quoted", amountOut: quoteOne(amount) } satisfies CandidateOutcome & { cause: "quoted" };
      },
      negativeProvable: () => true,
    };
    const quote = await discoverV2Quote(src, WETH, TOKEN, GROSS);
    expect(quote.legs).toHaveLength(2);
    expect(quote.fee).toBe(GROSS * 25n / 10_000n);
    expect(quote.feeBps).toBe(25);
    expect(quote.net).toBe(GROSS - quote.fee);
    expect(quote.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    // The fee is taken ONCE from gross: the legs allocate the NET, and never re-fee it.
    expect(quote.legs.reduce((sum, leg) => sum + leg.amountIn, 0n)).toBe(quote.net);
    expect(quote.legs.every((leg) => leg.amountIn > 0n)).toBe(true);
    expect(quote.amountOut).toBe(quote.legs.reduce((sum, leg) => sum + leg.amountOut, 0n));
    expect(() => validateV2Quote(quote)).not.toThrow();
  });
});

describe("attributeRouteFailure: the priority order is itself the policy", () => {
  const base: RouteAttemptTrace = {
    tokenIn: TOKEN, tokenOut: WETH, gross: GROSS, net: GROSS - GROSS * 25n / 10_000n,
    poolsReturned: 1, rejected: [], candidates: [], negativeProvable: false, notes: [], stages: [],
    multihop: { attempted: false, candidates: 0, note: null },
  };
  const candidate = (outcome: CandidateOutcome, over: Partial<RouteAttemptTrace["candidates"][number]> = {}) =>
    ({ poolId: "p", kind: 7, hooks: HOOKS, outcome, ...over });

  it("a budget outranks everything: nothing downstream was ever asked", () => {
    const error = attributeRouteFailure({
      ...base,
      candidates: [candidate({ cause: "budget", detail: "exceeded 64 calls" }), candidate({ cause: "reverted", detail: "ST" })],
    });
    expect(error.attribution).toBe("BUDGET_EXHAUSTED");
    expect(error.code).toBe("DISCOVERY_UNAVAILABLE");
  });

  it("a provider error outranks a revert, because the venue was never reached", () => {
    const error = attributeRouteFailure({
      ...base,
      candidates: [candidate({ cause: "rpc-error", detail: "429" }), candidate({ cause: "reverted", detail: "ST" })],
    });
    expect(error.attribution).toBe("QUOTE_RPC_FAILED");
  });

  it("a revert outranks a zero answer: a refusal is not a fact about liquidity", () => {
    const error = attributeRouteFailure({
      ...base,
      candidates: [candidate({ cause: "zero-output" }), candidate({ cause: "reverted", detail: "ST" })],
    });
    expect(error.attribution).toBe("HOOK_OR_TOKEN_INCOMPATIBLE");
    expect(error.code).toBe("DISCOVERY_UNAVAILABLE");
  });

  it("a hookless revert is a venue refusal, not a hook refusal", () => {
    const error = attributeRouteFailure({ ...base, candidates: [candidate({ cause: "reverted", detail: "ST" }, { hooks: zeroAddress })] });
    expect(error.attribution).toBe("VENUE_REJECTED_SWAP");
  });

  it("a non-v4 revert is never blamed on a hook", () => {
    const error = attributeRouteFailure({ ...base, candidates: [candidate({ cause: "reverted", detail: "ST" }, { kind: 1, hooks: null })] });
    expect(error.attribution).toBe("VENUE_REJECTED_SWAP");
  });

  it("zero output becomes a liquidity verdict only when the search was complete", () => {
    const candidates = [candidate({ cause: "zero-output" })];
    expect(attributeRouteFailure({ ...base, candidates, negativeProvable: false }).code).toBe("DISCOVERY_UNAVAILABLE");
    expect(attributeRouteFailure({ ...base, candidates, negativeProvable: true }).code).toBe("LIQUIDITY_UNAVAILABLE");
  });

  it("a capped search is treated as a budget even when no candidate recorded one", () => {
    const error = attributeRouteFailure({ ...base, notes: ["v4 Initialize search capped: stopped after a 3-window tail"] });
    expect(error.attribution).toBe("BUDGET_EXHAUSTED");
    expect(error.message).toMatch(/could not finish/i);
  });

  it("every attribution has a label, so a report can group by it", () => {
    const labels = Object.keys(ATTRIBUTION_LABELS);
    expect(labels).toContain("POOL_NOT_DISCOVERED");
    expect(labels).toContain("HOOK_OR_TOKEN_INCOMPATIBLE");
    expect(labels).toContain("EXECUTOR_VALIDATION_REJECTED");
    expect(labels).toContain("QUOTE_ZERO_OUTPUT");
    expect(labels).toContain("QUOTE_RPC_FAILED");
    expect(labels).toContain("BUDGET_EXHAUSTED");
    expect(labels.every((label) => ATTRIBUTION_LABELS[label as keyof typeof ATTRIBUTION_LABELS].length > 10)).toBe(true);
  });
});
