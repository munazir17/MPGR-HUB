// lib/swap/v2/rpc-v4.test.ts
// Bounded, hint-free Uniswap v4 discovery.
//
// EVIDENCE TIER — read before quoting any result from this file:
//   SIMULATED. The "chain" below is a fabricated in-process reader. Nothing here
//   contacted Base, so this is NOT fork evidence and NOT live evidence. What it
//   proves is the algorithm: that a sound search floor is DERIVED from code
//   presence, that a range-capped provider is handled by probing instead of
//   assuming, that only canonically re-derived PoolKeys become pools, and that a
//   search which cannot finish reports itself as unmeasured rather than as
//   "no liquidity".
//
// Fork evidence for the same discovery against real Base state lives in
// .github/workflows/swap-v2-fork-proof.yml + scripts/swap-deploy-v2/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { V4_MANAGER, discoverV2Quote, V2QuoteError, type V4Key } from "./discovery";
import { RpcV2LiquiditySource } from "./rpc-source";
import { probeLadder, V4DiscoveryCache, discoverV4Pools, findTokenDeploymentBlock, scanInitializeLogs, v4PoolKeyId, V4_SEARCH_LIMITS, isCapacityError, isLogRangeError } from "./rpc-v4";
import { buildV2Transaction } from "./transaction";
import { SWAP_V2_ABI } from "./abi";
import { NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { TAKER } from "./__tests__/helpers";

const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d" as Address;
const EXECUTOR = "0x4be1154440b26145d76608d41d403a33e76b9d0a" as Address;
/** MPGR, imported by address. It is in no app catalog and its only Base liquidity
 * is a Uniswap v4 pool, which is precisely why v4 discovery has to work. */
const MPGR = "0xb2000000000000000000008d204203177a78af01" as Address;
const OTHER = "0xa111111111111111111111111111111111111111" as Address;
/** Hooks contract of the fabricated pool. An INPUT to the mock, never an expected
 * output: discovery must recover it from the log, not from this file. */
const HOOKS = "0x985C14BAa2a18316ffdA0aeFB3a632fAdfcA2AcC" as Address;
/** Mock-only chain shape. These block numbers are fabricated state for the reader
 * below; no test asserts them as real Base facts. */
const HEAD = 52_856_963n;
const MPGR_DEPLOYED = 48_631_199n;
const OTHER_DEPLOYED = 51_000_000n;

/** The native/MPGR PoolKey the fabricated chain emits at MPGR_DEPLOYED + 1. */
const nativeMpgrKey: V4Key = { currency0: zeroAddress, currency1: MPGR, fee: 0, tickSpacing: 200, hooks: HOOKS };

const RANGE_REFUSAL = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.";

interface FabricatedPool {
  block: bigint;
  key: V4Key;
  /** Emit a non-canonical id, to prove the re-derivation check actually bites. */
  badId?: Hex;
}

interface ChainOptions {
  head?: bigint;
  /** token -> first block at which it has runtime code. Unlisted addresses are
   * treated as predeploys (code from block 0), like WETH on Base. */
  code?: Record<string, bigint>;
  /** Addresses with no runtime code at any block. */
  noCode?: Address[];
  pools?: FabricatedPool[];
  /** Refuse any `eth_getLogs` range wider than this, like a free-tier provider. */
  logRangeCap?: bigint;
  refuseAllLogs?: boolean;
  /** A sloppy provider that also returns logs the topic filter should have excluded. */
  unfilteredLogs?: FabricatedPool[];
  refuseArchiveCode?: boolean;
  /** Interior historical code reads fail; block 0 and head still answer. */
  refuseInteriorArchive?: boolean;
  quoteOut?: bigint;
}

interface MockChain {
  client: PublicClient;
  calls: { getLogs: number; getCode: number; call: number };
  /** Log queries the provider actually SERVED (refused ranges are not included),
   * so assertions about where the search looked are about real work. */
  served: { address: string; from: bigint; to: bigint; args: Record<string, string> }[];
  callArgs: { to: string; data: Hex }[];
  /** Peak simultaneous `eth_getLogs` calls. A real provider overlaps them; the mock
   * yields so a scan that issues calls in parallel is actually measured as parallel. */
  concurrency: { live: number; max: number };
}

const matches = (key: V4Key, args: Record<string, string | undefined>): boolean =>
  (args.currency0 === undefined || args.currency0.toLowerCase() === key.currency0.toLowerCase()) &&
  (args.currency1 === undefined || args.currency1.toLowerCase() === key.currency1.toLowerCase());

function chain(options: ChainOptions = {}): MockChain {
  const head = options.head ?? HEAD;
  const code = options.code ?? {};
  const noCode = new Set((options.noCode ?? []).map((a) => a.toLowerCase()));
  const pools = options.pools ?? [];
  const unfiltered = options.unfilteredLogs ?? [];
  const calls = { getLogs: 0, getCode: 0, call: 0 };
  const served: MockChain["served"] = [];
  const callArgs: MockChain["callArgs"] = [];
  const concurrency = { live: 0, max: 0 };

  const reader = {
    async getLogs(query: { address?: string; args?: Record<string, string>; fromBlock: bigint; toBlock: bigint }) {
      calls.getLogs++;
      if (options.refuseAllLogs) throw new Error(RANGE_REFUSAL);
      if (options.logRangeCap !== undefined && query.toBlock - query.fromBlock + 1n > options.logRangeCap) {
        throw new Error(RANGE_REFUSAL);
      }
      served.push({
        address: String(query.address).toLowerCase(), from: query.fromBlock, to: query.toBlock,
        args: Object.fromEntries(Object.entries(query.args ?? {}).map(([k, v]) => [k, String(v).toLowerCase()])),
      });
      concurrency.live++;
      if (concurrency.live > concurrency.max) concurrency.max = concurrency.live;
      // Yield so genuinely concurrent calls overlap the way they would on a network.
      await Promise.resolve();
      concurrency.live--;
      if (String(query.address).toLowerCase() !== V4_MANAGER.toLowerCase()) return [];
      const inRange = (p: FabricatedPool) => p.block >= query.fromBlock && p.block <= query.toBlock;
      return [
        ...pools.filter((p) => inRange(p) && matches(p.key, query.args ?? {})),
        ...unfiltered.filter(inRange),
      ].map((p) => ({
        blockNumber: p.block,
        transactionHash: `0x${"11".repeat(32)}` as Hex,
        args: {
          id: p.badId ?? v4PoolKeyId(p.key), currency0: p.key.currency0, currency1: p.key.currency1,
          fee: p.key.fee, tickSpacing: p.key.tickSpacing, hooks: p.key.hooks,
        },
      }));
    },
    async getCode(query: { address: Address; blockNumber?: bigint }) {
      calls.getCode++;
      const address = query.address.toLowerCase();
      if (noCode.has(address)) return "0x" as Hex;
      const block = query.blockNumber ?? head;
      if (options.refuseArchiveCode && block !== head) throw new Error("archive state is not available on this plan");
      if (options.refuseInteriorArchive && block !== head && block !== 0n) throw new Error("Archive requests require a personal token");
      const deployedAt = code[address];
      if (deployedAt === undefined) return "0x6080604052" as Hex; // predeploy-like: code from block 0
      return block >= deployedAt ? ("0x6080604052" as Hex) : ("0x" as Hex);
    },
    async getBlock() { return { timestamp: 1_760_000_000n }; },
    async call(query: { to?: string; data?: Hex }) {
      calls.call++;
      const to = String(query.to ?? "").toLowerCase();
      callArgs.push({ to, data: query.data ?? "0x" });
      if (to === V4_QUOTER) {
        // The v4 quoter reads real PoolManager state, so a successful quote here is
        // the mock's stand-in for "the PoolManager accepts this PoolKey".
        return { data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [options.quoteOut ?? 1_000n, 200_000n]) };
      }
      // Every canonical factory getter answers "no such pool", so the bounded index
      // contributes nothing and the v4 search is what is actually under test.
      return { data: encodeAbiParameters([{ type: "address" }], [zeroAddress]) };
    },
  };
  return { client: reader as unknown as PublicClient, calls, served, callArgs, concurrency };
}

interface QuoterParams { poolKey: V4Key; zeroForOne: boolean; exactAmount: bigint; hookData: Hex }

/** Decodes the v4 quoter call the source actually made. Locating the call by its
 * destination AND its ABI is stronger than assuming it was the first one. */
function v4QuoterCall(c: MockChain): QuoterParams {
  const abi = parseAbi(["function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256,uint256)"]);
  for (const { to, data } of c.callArgs) {
    if (to !== V4_QUOTER) continue;
    try {
      const decoded = decodeFunctionData({ abi, data }) as unknown as { args: [QuoterParams] };
      return decoded.args[0];
    } catch { /* a different venue's encoding */ }
  }
  throw new Error(`The canonical v4 quoter ${V4_QUOTER} was never called.`);
}

const budget = () => {};
const limits = (over: Partial<typeof V4_SEARCH_LIMITS> = {}) => ({ ...V4_SEARCH_LIMITS, ...over });
/** The MPGR-shaped chain: token deployed at MPGR_DEPLOYED, native pool one block
 * later, on a provider that caps eth_getLogs at 10 blocks (the refusal the fork
 * proof hit on a free-tier RPC). */
const mpgrChain = (extra: ChainOptions = {}) => chain({
  code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED },
  pools: [{ block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey }],
  logRangeCap: 10n,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("v4 discovery: chain-derived search floor", () => {
  it("binary-searches the first block at which the token has code, bounded", async () => {
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED } });
    const floor = await findTokenDeploymentBlock(c.client, MPGR, HEAD, limits(), budget);
    expect(floor.kind).toBe("block");
    expect(floor.block).toBe(MPGR_DEPLOYED);
    // log2(52.8M) ~= 26 probes; the cap is a hard bound, not a hope.
    expect(floor.codeCalls).toBeLessThanOrEqual(V4_SEARCH_LIMITS.maxCodeSteps);
    expect(floor.codeCalls).toBeLessThan(40);
    // Only eth_getCode was used: no eth_getLogs range was needed to find the floor.
    expect(c.calls.getLogs).toBe(0);
  });

  it("reports an address with no runtime code as an authoritative negative, not a failure", async () => {
    const c = chain({ noCode: [OTHER] });
    const floor = await findTokenDeploymentBlock(c.client, OTHER, HEAD, limits(), budget);
    expect(floor).toMatchObject({ kind: "no-code", block: null });
    const result = await discoverV4Pools(c.client, OTHER, USDC, HEAD, {}, budget);
    expect(result.state).toBe("complete");
    expect(result.pools).toEqual([]);
    // No log query was spent to reach a verdict it could already prove.
    expect(c.calls.getLogs).toBe(0);
  });

  it("says 'unavailable' when every historical code read is refused and the token has no verified floor", async () => {
    const c = chain({ refuseArchiveCode: true, code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED } });
    // MPGR has a verified floor, so its own search can continue. An arbitrary
    // token cannot: refusing history with nothing to fall back on stays unmeasured.
    const mpgrFloor = await findTokenDeploymentBlock(c.client, MPGR, HEAD, limits(), budget);
    expect(mpgrFloor).toMatchObject({ kind: "block", block: MPGR_DEPLOYED });
    const unknown = await findTokenDeploymentBlock(c.client, OTHER, HEAD, limits(), budget);
    expect(unknown.kind).toBe("unavailable");
    const result = await discoverV4Pools(c.client, WETH, OTHER, HEAD, {}, budget);
    expect(result.state).toBe("unavailable");
    expect(result.pools).toEqual([]);
    expect(result.note).toMatch(/floor could not be derived/i);
  });

  it("finds the MPGR v4 pool from the verified floor when interior archive reads are refused", async () => {
    const c = chain({
      refuseInteriorArchive: true,
      code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED },
      pools: [{ block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey }],
      logRangeCap: 10n,
    });
    const floor = await findTokenDeploymentBlock(c.client, MPGR, HEAD, limits(), budget);
    expect(floor).toMatchObject({ kind: "block", block: MPGR_DEPLOYED });
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.state).not.toBe("unavailable");
    expect(result.pools.some((pool) => pool.v4Key?.currency1.toLowerCase() === MPGR.toLowerCase())).toBe(true);
  });

  it("never guesses a floor: a capped code-step budget is unavailable", async () => {
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED } });
    const floor = await findTokenDeploymentBlock(c.client, MPGR, HEAD, limits({ maxCodeSteps: 4 }), budget);
    expect(floor.kind).toBe("unavailable");
    // The counter reports ISSUED calls only, so it never exceeds the cap itself.
    expect(floor.codeCalls).toBeLessThanOrEqual(4);
  });

  it("searches from the LATER of the two deployment blocks — the tighter sound floor", async () => {
    const key: V4Key = { currency0: OTHER, currency1: MPGR, fee: 500, tickSpacing: 10, hooks: zeroAddress };
    const c = chain({
      code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED, [OTHER.toLowerCase()]: OTHER_DEPLOYED },
      pools: [{ block: OTHER_DEPLOYED + 5n, key }],
      logRangeCap: 10n,
    });
    const result = await discoverV4Pools(c.client, MPGR, OTHER, HEAD, {}, budget);
    expect(result.searched?.toLowerCase()).toBe(OTHER.toLowerCase());
    expect(result.floor).toBe(OTHER_DEPLOYED);
    expect(result.pools).toHaveLength(1);
    // The scan never looked below the later floor, which is what makes a
    // range-capped provider able to converge at all.
    expect(c.served.length).toBeGreaterThan(0);
    expect(c.served.every((q) => q.from >= OTHER_DEPLOYED)).toBe(true);
  });
});

describe("v4 discovery: MPGR/native pool with no hint and a range-capped provider", () => {
  it("recovers the PoolKey from canonical logs on a 10-block-capped provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no third-party hint source was contacted"); }));
    const c = mpgrChain();
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    // No hint API was used: discovery is chain-only.
    expect(fetch).not.toHaveBeenCalled();
    expect(result.pools).toHaveLength(1);
    const pool = result.pools[0];
    expect(pool.kind).toBe(7);
    expect(pool.pool.toLowerCase()).toBe(V4_MANAGER.toLowerCase());
    expect(pool.router.toLowerCase()).toBe(V4_MANAGER.toLowerCase());
    expect(pool.factory.toLowerCase()).toBe(V4_MANAGER.toLowerCase());
    // The native side stays the zero address in the key (what the PoolManager
    // hashes) while the Pool's token0 is canonical WETH (what the app routes).
    expect(pool.v4Key).toEqual(nativeMpgrKey);
    expect(pool.token0.toLowerCase()).toBe(WETH.toLowerCase());
    expect(pool.token1.toLowerCase()).toBe(MPGR.toLowerCase());
    // The pool id was RE-DERIVED from the key, not copied from a hint or a literal.
    expect(pool.id).toBe(`${V4_MANAGER.toLowerCase()}:${v4PoolKeyId(nativeMpgrKey).toLowerCase()}`);
    // Bounded: probe refusals plus a few 10-block windows, not a block-0 scan.
    expect(result.logCalls).toBeLessThanOrEqual(V4_SEARCH_LIMITS.maxLogCalls);
    expect(result.logCalls).toBeLessThan(30);
    expect(c.served.every((q) => q.to - q.from + 1n <= 10n)).toBe(true);
    // A match stops the scan early, and the result SAYS it did not reach head.
    expect(result.state).toBe("capped");
    expect(result.note).toMatch(/stopped after/i);
  });

  it("answers in one wide query per topic position when the provider allows the full range", async () => {
    const c = chain({
      code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED },
      pools: [{ block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey }],
    });
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.state).toBe("complete");
    expect(result.scannedTo).toBe(HEAD);
    expect(result.pools).toHaveLength(1);
    // currency0 and currency1 positions only — the pool id was never needed.
    expect(result.logCalls).toBeLessThanOrEqual(4);
  });

  it("finds the same pool from either direction of the pair", async () => {
    for (const [from, to] of [[WETH, MPGR], [MPGR, WETH]] as [Address, Address][]) {
      const c = mpgrChain();
      const result = await discoverV4Pools(c.client, from, to, HEAD, {}, budget);
      expect(result.pools).toHaveLength(1);
      expect(result.pools[0].v4Key).toEqual(nativeMpgrKey);
    }
  });

  it("reuses one scan for both directions when a cache is shared", async () => {
    const cache = new V4DiscoveryCache();
    const c = mpgrChain();
    const first = await discoverV4Pools(c.client, WETH, MPGR, HEAD, { cache }, budget);
    expect(first.pools).toHaveLength(1);
    const afterFirst = { ...c.calls };
    const second = await discoverV4Pools(c.client, MPGR, WETH, HEAD, { cache }, budget);
    expect(second.pools).toHaveLength(1);
    expect(second.pools[0].id).toBe(first.pools[0].id);
    // The floor search and the Initialize scan are per (token, block): the reverse
    // direction of the same pair must not pay for them twice.
    expect(c.calls.getLogs).toBe(afterFirst.getLogs);
    expect(c.calls.getCode).toBe(afterFirst.getCode);
  });

  it("routes the native ETH sentinel through the discovered pool with the 25 bps fee intact", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = mpgrChain();
    const source = new RpcV2LiquiditySource(c.client, HEAD, 4096, 0, { cache: new V4DiscoveryCache() });
    const gross = 1_000_000n;
    const quote = await discoverV2Quote(source, NATIVE_ETH_SENTINEL, MPGR, gross);
    expect(quote.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
    expect(quote.tokenOut.toLowerCase()).toBe(MPGR.toLowerCase());
    expect(quote.feeBps).toBe(25);
    expect(quote.fee).toBe((gross * 25n) / 10_000n);
    expect(quote.net).toBe(gross - quote.fee);
    expect(quote.legs).toHaveLength(1);
    expect(quote.legs[0].pools[0].v4Key).toEqual(nativeMpgrKey);

    // QUOTE PATH. The PoolKey the search derived is the one the canonical v4
    // quoter was asked to price — byte for byte, through the app's own encoder.
    const quoted = v4QuoterCall(c);
    expect(quoted.zeroForOne).toBe(true);
    expect(quoted.exactAmount).toBe(quote.net);
    expect(quoted.hookData).toBe("0x");
    expect(quoted.poolKey).toBeDefined();
    expect(quoted.poolKey.currency0.toLowerCase()).toBe(zeroAddress);
    expect(quoted.poolKey.currency1.toLowerCase()).toBe(MPGR.toLowerCase());
    expect(quoted.poolKey.fee).toBe(0);
    expect(quoted.poolKey.tickSpacing).toBe(200);
    expect(quoted.poolKey.hooks.toLowerCase()).toBe(HOOKS.toLowerCase());

    // EXECUTION PATH. The same PoolKey must survive into the real calldata the
    // deployed executor would be asked to run.
    const built = buildV2Transaction(quote, EXECUTOR, TAKER, 9_999_999_999n, 100, true, false);
    const decoded = decodeFunctionData({ abi: SWAP_V2_ABI, data: built.data }) as unknown as {
      functionName: string;
      args: [{ expectedFeeAmount: bigint; grossAmountIn: bigint; tokenIn: Address; tokenOut: Address }, { kind: number; router: Address; pool: Address; tokenOut: Address; v4Key: V4Key }[]];
    };
    expect(decoded.functionName).toBe("swapExactInput");
    const [params, path] = decoded.args;
    expect(params.grossAmountIn).toBe(gross);
    expect(params.expectedFeeAmount).toBe((gross * 25n) / 10_000n);
    // viem returns EIP-55 checksummed addresses when decoding, so every address
    // comparison against a lowercase fixture has to be case-insensitive.
    expect(params.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
    expect(params.tokenOut.toLowerCase()).toBe(MPGR.toLowerCase());
    expect(path).toHaveLength(1);
    expect(path[0].kind).toBe(7);
    expect(path[0].router.toLowerCase()).toBe(V4_MANAGER.toLowerCase());
    expect(path[0].pool.toLowerCase()).toBe(V4_MANAGER.toLowerCase());
    expect(path[0].tokenOut.toLowerCase()).toBe(MPGR.toLowerCase());
    expect(path[0].v4Key.currency0.toLowerCase()).toBe(zeroAddress);
    expect(path[0].v4Key.currency1.toLowerCase()).toBe(MPGR.toLowerCase());
    expect(path[0].v4Key.fee).toBe(0);
    expect(path[0].v4Key.tickSpacing).toBe(200);
    expect(path[0].v4Key.hooks.toLowerCase()).toBe(HOOKS.toLowerCase());
    // Native in: the executor is paid in ETH, and a minimum output is committed.
    expect(built.value).toBe(gross);
    expect(built.minimum).toBe((quote.amountOut * 9_900n) / 10_000n);
    // Round-trip proof that the encoding is the ABI the executor exposes.
    expect(encodeFunctionData({ abi: SWAP_V2_ABI, functionName: "swapExactInput", args: decoded.args as never })).toBe(built.data);
  });
});

describe("v4 discovery: invalid and duplicate candidate logs", () => {
  it("rejects a log whose indexed id is not keccak256 of its own PoolKey", async () => {
    const c = mpgrChain({ pools: [{ block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey, badId: `0x${"12".repeat(32)}` as Hex }] });
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.pools).toEqual([]);
    expect(result.rejected.some((r) => /does not equal keccak256\(PoolKey\)/.test(r.reason))).toBe(true);
  });

  it("rejects unsorted currencies and out-of-range tick spacing", async () => {
    const unsorted: V4Key = { currency0: MPGR, currency1: OTHER, fee: 100, tickSpacing: 10, hooks: zeroAddress };
    const zeroSpacing: V4Key = { currency0: OTHER, currency1: MPGR, fee: 0, tickSpacing: 0, hooks: zeroAddress };
    const hugeSpacing: V4Key = { currency0: OTHER, currency1: MPGR, fee: 0, tickSpacing: 32_768, hooks: zeroAddress };
    const c = chain({
      code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED, [OTHER.toLowerCase()]: MPGR_DEPLOYED },
      pools: [
        { block: MPGR_DEPLOYED + 1n, key: unsorted },
        { block: MPGR_DEPLOYED + 1n, key: zeroSpacing },
        { block: MPGR_DEPLOYED + 1n, key: hugeSpacing },
      ],
    });
    const result = await discoverV4Pools(c.client, OTHER, MPGR, HEAD, {}, budget);
    expect(result.pools).toEqual([]);
    const reasons = result.rejected.map((r) => r.reason).join(" | ");
    expect(reasons).toMatch(/currency0 must sort below currency1/);
    expect(reasons).toMatch(/tickSpacing 0 outside \[1,32767\]/);
    expect(reasons).toMatch(/tickSpacing 32768 outside \[1,32767\]/);
  });

  it("ignores a log a sloppy provider returns for a different token", async () => {
    const c = mpgrChain({
      unfilteredLogs: [{ block: MPGR_DEPLOYED + 1n, key: { currency0: USDC, currency1: OTHER, fee: 500, tickSpacing: 10, hooks: zeroAddress } }],
    });
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].v4Key).toEqual(nativeMpgrKey);
    expect(result.rejected.some((r) => /does not involve the searched token/.test(r.reason))).toBe(true);
  });

  it("collapses duplicate candidates into one pool, and keeps genuinely distinct ones", async () => {
    // Same pair, two real pools: a native pool with hooks and a WETH pool without.
    // Both are canonical, so both must survive — but each only once, even though
    // every topic position and every overlapping window returns them again.
    const wethMpgr: V4Key = { currency0: WETH, currency1: MPGR, fee: 3_000, tickSpacing: 60, hooks: zeroAddress };
    const c = mpgrChain({
      pools: [
        { block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey },
        { block: MPGR_DEPLOYED + 1n, key: wethMpgr },
      ],
      unfilteredLogs: [
        { block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey },
        { block: MPGR_DEPLOYED + 1n, key: wethMpgr },
      ],
    });
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    const ids = result.pools.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(`${V4_MANAGER.toLowerCase()}:${v4PoolKeyId(nativeMpgrKey).toLowerCase()}`);
    expect(ids).toContain(`${V4_MANAGER.toLowerCase()}:${v4PoolKeyId(wethMpgr).toLowerCase()}`);
    // Four served queries (two topic positions, each returning both pools twice)
    // still produced exactly two pools.
    expect(c.served.length).toBeGreaterThan(2);
  });

  it("applies the pair filter per call over one cached per-token scan", async () => {
    const cache = new V4DiscoveryCache();
    const c = chain({
      code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED, [OTHER.toLowerCase()]: OTHER_DEPLOYED },
      pools: [{ block: OTHER_DEPLOYED + 1n, key: { currency0: OTHER, currency1: MPGR, fee: 500, tickSpacing: 10, hooks: zeroAddress } }],
    });
    const mpgrOther = await discoverV4Pools(c.client, MPGR, OTHER, HEAD, { cache }, budget);
    expect(mpgrOther.pools).toHaveLength(1);
    const afterFirst = { ...c.calls };
    // A cached scan is per TOKEN; the verdict is per PAIR. The same scan is reused
    // for OTHER/USDC, which the pair filter must reject: no other pool exists.
    const otherUsdc = await discoverV4Pools(c.client, OTHER, USDC, HEAD, { cache }, budget);
    expect(otherUsdc.pools).toEqual([]);
    expect(otherUsdc.searched?.toLowerCase()).toBe(OTHER.toLowerCase());
    expect(c.calls.getLogs).toBe(afterFirst.getLogs);
  });
});

describe("v4 discovery: bounds and honest failure", () => {
  it("reports 'unavailable' — never 'no pool' — when every log range is refused", async () => {
    const c = mpgrChain({ refuseAllLogs: true });
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.state).toBe("unavailable");
    expect(result.pools).toEqual([]);
    expect(result.note).toMatch(/refused every v4 log range/);
    // It gave up after probing the smallest span, not after a runaway fan-out.
    expect(result.logCalls).toBeLessThanOrEqual(V4_SEARCH_LIMITS.probeSpans.length + 1);
    expect(result.logCalls).toBeLessThanOrEqual(V4_SEARCH_LIMITS.maxLogCalls);
  });

  it("does not fan out on a transport failure that is not a range refusal", async () => {
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED } });
    (c.client as unknown as { getLogs: (q: unknown) => Promise<unknown> }).getLogs = async () => {
      throw new Error("fetch failed: socket hang up");
    };
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.state).toBe("unavailable");
    expect(result.note).toMatch(/socket hang up/);
    // Exactly one attempt: a network failure is not a licence to retry at scale.
    expect(result.logCalls).toBe(1);
  });

  it("shrinks an archive refusal until the deployment-floor window is served", async () => {
    // publicnode rejects every historical eth_getLogs, wide or narrow, as
    // "Archive requests require a personal token" wrapped in invalid params.
    // That is not a dead search: a 1000-block window at the token floor is a
    // different request, and it is where MPGR's pool was initialized.
    expect(isLogRangeError(new Error(
      "Invalid parameters were provided to the RPC method. Details: Archive requests require a personal token.",
    ))).toBe(true);
    expect(isLogRangeError(Object.assign(new Error("Invalid parameters were provided to the RPC method."), {
      cause: { data: "Block range too large: maximum 1000 blocks without an access key." },
    }))).toBe(true);
    const c = mpgrChain();
    const original = c.client.getLogs.bind(c.client);
    (c.client as unknown as { getLogs: (q: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown> }).getLogs = async (query) => {
      if (query.toBlock - query.fromBlock + 1n > 1_000n) {
        throw new Error("Invalid parameters were provided to the RPC method. Details: Archive requests require a personal token.");
      }
      return original(query);
    };
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].v4Key).toEqual(nativeMpgrKey);
    expect(result.state).toBe("capped");
    expect(result.logCalls).toBeLessThanOrEqual(V4_SEARCH_LIMITS.maxLogCalls);
  });

  it("keeps a pool found at the deployment floor when a later window hits a rate limit", async () => {
    const c = mpgrChain();
    const original = c.client.getLogs.bind(c.client);
    (c.client as unknown as { getLogs: (q: { fromBlock: bigint; toBlock: bigint }) => Promise<unknown> }).getLogs = async (query) => {
      // Backward windows start at the head. A rate limit there must not erase
      // the pool already read from the deployment floor.
      if (query.fromBlock > MPGR_DEPLOYED + 100n) throw new Error("request limit reached");
      return original(query);
    };
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].v4Key).toEqual(nativeMpgrKey);
    expect(result.state).toBe("capped");
    expect(isCapacityError(new Error("request limit reached"))).toBe(true);
  });

  it("reports 'capped' when the pool sits beyond the bounded scan window", async () => {
    // The pool exists, but 5,000 blocks after the floor: a 10-block-capped provider
    // cannot reach it inside the call budget. The honest answer is "not measured".
    const c = mpgrChain({ pools: [{ block: MPGR_DEPLOYED + 5_000n, key: nativeMpgrKey }] });
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, budget);
    expect(result.pools).toEqual([]);
    expect(result.state).toBe("capped");
    expect(result.scannedTo).not.toBe(HEAD);
    expect(result.logCalls).toBeLessThanOrEqual(V4_SEARCH_LIMITS.maxLogCalls);
  });

  it("a capped v4 search makes the pair UNMEASURED, not illiquid, end to end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = mpgrChain({ pools: [{ block: MPGR_DEPLOYED + 5_000n, key: nativeMpgrKey }] });
    const source = new RpcV2LiquiditySource(c.client, HEAD, 4096, 0, { cache: new V4DiscoveryCache() });
    await expect(discoverV2Quote(source, WETH, MPGR, 1_000_000n)).rejects.toMatchObject({ code: "DISCOVERY_UNAVAILABLE" });
    // Per pair, not "whichever pair was touched last": the attempt ends by asking for
    // multi-hop neighbours, which fails fast and would otherwise leave an empty record.
    const diag = source.diagnosticsFor(WETH, MPGR);
    expect(diag.v4?.state).toBe("capped");
    expect(diag.v4?.note).toMatch(/exceeded its 64-call budget/);
    expect(diag.factoryIndex?.pools).toEqual([]);
  });

  it("returns a complete-scan negative only when v4 AND the sweep both finished", async () => {
    // A capable provider (no cap) with no pools anywhere: this is the one shape in
    // which "no compatible pool" is a real verdict rather than an unmeasured pair.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED } });
    const source = new RpcV2LiquiditySource(c.client, HEAD, 8192, 2000, { cache: new V4DiscoveryCache() });
    await expect(source.pools(MPGR, OTHER)).resolves.toEqual([]);
    const diag = source.diagnostics();
    expect(diag.historyScan).toBe("complete");
    expect(diag.v4?.state).toBe("complete");
    await expect(discoverV2Quote(source, MPGR, OTHER, 1_000_000n)).rejects.toMatchObject({ code: "LIQUIDITY_UNAVAILABLE" });
  });

  it("stops neighbour enumeration immediately when no log range is available", async () => {
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED } });
    const source = new RpcV2LiquiditySource(c.client, HEAD, 4096, 0, { cache: new V4DiscoveryCache() });
    await expect(source.pools(MPGR)).rejects.toMatchObject({ code: "DISCOVERY_UNAVAILABLE" });
    expect(source.diagnostics().historyScan).toBe("not-run");
    // Failing fast is the point: no budget was burned to reach a verdict it cannot
    // defend, and no partial neighbour set was handed to multi-hop routing.
    expect(c.calls.getLogs).toBe(0);
    expect(c.calls.getCode).toBe(0);
  });

  it("a refused v4 log range degrades to an unavailable diagnostic, not an unhandled failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const c = mpgrChain({ refuseAllLogs: true });
    const source = new RpcV2LiquiditySource(c.client, HEAD, 4096, 0, { cache: new V4DiscoveryCache() });
    await expect(source.pools(WETH, MPGR)).rejects.toBeInstanceOf(V2QuoteError);
    const diag = source.diagnostics();
    expect(diag.v4?.state).toBe("unavailable");
    expect(diag.v4?.note).toMatch(/refused every v4 log range/);
    // The message must say WHY the pair is unmeasured, for the UI and the matrix.
    await expect(source.pools(WETH, MPGR)).rejects.toThrow(/v4 search unavailable/i);
  });

  it("a blown shared read budget becomes an unavailable v4 result, not a thrown error", async () => {
    const c = mpgrChain();
    const exhausted = () => { throw new V2QuoteError("DISCOVERY_UNAVAILABLE", "RPC pool discovery budget exceeded"); };
    const result = await discoverV4Pools(c.client, WETH, MPGR, HEAD, {}, exhausted);
    expect(result.state).toBe("unavailable");
    expect(result.pools).toEqual([]);
    expect(result.note).toMatch(/floor could not be derived|could not run/i);
  });

  it("scans a token with no counterparty (multi-hop neighbour mode)", async () => {
    const c = mpgrChain();
    const result = await discoverV4Pools(c.client, MPGR, undefined, HEAD, {}, budget);
    expect(result.searched?.toLowerCase()).toBe(MPGR.toLowerCase());
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].v4Key).toEqual(nativeMpgrKey);
  });

  it("keeps the search honest when the scan finds nothing at all", async () => {
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED } });
    const result = await scanInitializeLogs(c.client, MPGR, MPGR_DEPLOYED, MPGR_DEPLOYED + 50n, limits(), budget);
    expect(result.state).toBe("complete");
    expect(result.scannedTo).toBe(MPGR_DEPLOYED + 50n);
    expect(result.pools).toEqual([]);
    expect(result.note).toMatch(/0 canonical pool\(s\)/);
  });

  it("an empty range is complete, not an error", async () => {
    const c = chain({});
    const result = await scanInitializeLogs(c.client, MPGR, HEAD + 1n, HEAD, limits(), budget);
    expect(result.state).toBe("complete");
    expect(result.pools).toEqual([]);
    expect(c.calls.getLogs).toBe(0);
  });
});

describe("provider log-span reuse", () => {
  // The span a provider will serve is a property of the PROVIDER, not of the token.
  // Re-measuring it per token is pure budget burn on a capped endpoint, but a stale
  // hint must never change what gets scanned — only how fast the scan starts.
  const budget = () => {};
  const twoPools = (): FabricatedPool[] => [
    { block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey },
    { block: OTHER_DEPLOYED + 1n, key: { currency0: zeroAddress, currency1: OTHER, fee: 500, tickSpacing: 10, hooks: zeroAddress } },
  ];
  const codeMap = () => ({ [MPGR.toLowerCase()]: MPGR_DEPLOYED, [OTHER.toLowerCase()]: OTHER_DEPLOYED });
  /** Refusals are queries the provider rejected; `served` records only real work. */
  const refused = (c: MockChain) => c.calls.getLogs - c.served.length;

  it("offers the whole range first, then a measured span, then the ladder, deduplicated", () => {
    expect(probeLadder(500n, 10n, [1_000_000n, 10n, 5n])).toEqual([500n, 10n, 1_000_000n, 5n]);
    expect(probeLadder(10n, null, [10n, 5n])).toEqual([10n, 5n]);
    expect(probeLadder(0n, 0n, [10n])).toEqual([10n]);
    expect(probeLadder(900n, undefined, V4_SEARCH_LIMITS.probeSpans)[0]).toBe(900n);
  });

  it("reuses one measured span for the next token instead of re-probing refused ranges", async () => {
    const c = chain({ code: codeMap(), pools: twoPools(), logRangeCap: 10n });
    const cache = new V4DiscoveryCache();
    const first = await cache.search(c.client, MPGR, HEAD, V4_SEARCH_LIMITS, budget);
    expect(first.spanServed).toBe(10n);
    expect(first.pools.length).toBeGreaterThan(0);
    const firstCalls = c.calls.getLogs;
    const firstRefusals = refused(c);
    expect(firstRefusals).toBe(6); // total + 1e6/1e5/1e4/1e3/100 all refused before 10 worked

    const before = c.calls.getLogs;
    const second = await cache.search(c.client, OTHER, HEAD, V4_SEARCH_LIMITS, budget);
    expect(second.spanServed).toBe(10n);
    // The hint cannot invent a pool: OTHER's own pool is still found and verified.
    expect(second.pools.map((p) => p.v4Key!.currency1.toLowerCase())).toContain(OTHER.toLowerCase());
    expect(refused(c) - firstRefusals).toBe(1); // only `total` refused; the hint was accepted
    // Same shape of scan, five fewer wasted probes: reuse buys budget, it does not
    // change what is scanned.
    expect(c.calls.getLogs - before).toBeLessThan(firstCalls);
  });

  it("falls back to the full ladder when a cached span is no longer served", async () => {
    const options: ChainOptions = { code: codeMap(), pools: twoPools(), logRangeCap: 100_000n };
    const c = chain(options);
    const cache = new V4DiscoveryCache();
    const first = await cache.search(c.client, MPGR, HEAD, V4_SEARCH_LIMITS, budget);
    expect(first.spanServed).toBe(100_000n);

    options.logRangeCap = 10n; // the provider got stricter between tokens
    const second = await cache.search(c.client, OTHER, HEAD, V4_SEARCH_LIMITS, budget);
    expect(second.spanServed).toBe(10n);
    expect(second.pools.map((p) => p.v4Key!.currency1.toLowerCase())).toContain(OTHER.toLowerCase());
    expect(second.state).not.toBe("unavailable");
  });

  it("never caches a span the provider refused, so a dead provider is not remembered as capable", async () => {
    const c = chain({ code: codeMap(), pools: twoPools(), refuseAllLogs: true });
    const cache = new V4DiscoveryCache();
    const first = await cache.search(c.client, MPGR, HEAD, V4_SEARCH_LIMITS, budget);
    expect(first.state).toBe("unavailable");
    expect(first.spanServed ?? null).toBeNull();
    expect(first.pools).toEqual([]);
    const before = refused(c);
    const second = await cache.search(c.client, OTHER, HEAD, V4_SEARCH_LIMITS, budget);
    expect(second.state).toBe("unavailable");
    // No hint was stored, so the second token probes the whole ladder again.
    expect(refused(c) - before).toBe(7);
  });

  it("reports the served span through discoverV4Pools so a run can show what it could scan", async () => {
    const c = chain({ code: codeMap(), pools: twoPools(), logRangeCap: 10n });
    const result = await discoverV4Pools(c.client, MPGR, WETH, HEAD, { cache: new V4DiscoveryCache() }, budget);
    expect(result.spanServed).toBe(10n);
    expect(result.searched?.toLowerCase()).toBe(MPGR.toLowerCase());
  });
});

describe("v4 discovery: two-sided bounded scan", () => {
  /** Unique block ranges the provider actually served, for the PoolManager only. */
  const rangesOf = (c: MockChain) => {
    const seen = new Map<string, { from: bigint; to: bigint }>();
    for (const served of c.served.filter((s) => s.address === V4_MANAGER.toLowerCase())) {
      seen.set(`${served.from}-${served.to}`, { from: served.from, to: served.to });
    }
    return [...seen.values()];
  };
  /** Greedily walks the served ranges outward from each end. Anything that belongs to
   * neither contiguous chain is a skipped block, which is the thing this suite must
   * never allow a bounded scan to do silently. */
  const chains = (c: MockChain, floor: bigint, head: bigint) => {
    const remaining = rangesOf(c);
    const forward: { from: bigint; to: bigint }[] = [];
    const backward: { from: bigint; to: bigint }[] = [];
    let top = floor - 1n;
    let bottom = head + 1n;
    for (;;) {
      const at = remaining.findIndex((r) => r.from === top + 1n);
      if (at < 0) break;
      const range = remaining.splice(at, 1)[0];
      forward.push(range); top = range.to;
    }
    for (;;) {
      const at = remaining.findIndex((r) => r.to === bottom - 1n);
      if (at < 0) break;
      const range = remaining.splice(at, 1)[0];
      backward.push(range); bottom = range.from;
    }
    return { forward, backward, unassigned: remaining, top, bottom };
  };

  it("finds a pool initialized long AFTER the token's deployment, which a forward-only scan cannot reach", async () => {
    // The gap between MPGR's deployment block and the pinned head is ~4.2M blocks. On a
    // ten-block provider a forward-only scan covers a few hundred of them and reports
    // nothing, so a pool created recently was simply invisible. This is the case the
    // backward side exists for.
    const lateBlock = HEAD - 25n;
    const c = chain({
      code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED },
      pools: [{ block: lateBlock, key: nativeMpgrKey }],
      logRangeCap: 10n,
    });
    const result = await discoverV4Pools(c.client, MPGR, WETH, HEAD, {}, budget);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].id).toBe(`${V4_MANAGER.toLowerCase()}:${v4PoolKeyId(nativeMpgrKey).toLowerCase()}`);
    expect(result.pools[0].v4Key).toMatchObject({ currency0: zeroAddress, currency1: MPGR, fee: 0, tickSpacing: 200, hooks: HOOKS });
    // The BACKWARD side reached it; the forward side never got close.
    expect(result.scannedFrom).not.toBeNull();
    expect(result.scannedFrom!).toBeLessThanOrEqual(lateBlock);
    expect(result.scannedTo!).toBeLessThan(lateBlock);
    // Finding a pool is a positive. Claiming the search was exhaustive is not, and the
    // uncovered middle is named rather than left to the reader's imagination.
    expect(result.state).toBe("capped");
    expect(result.note).toMatch(/were NOT scanned/);
    expect(result.note).toMatch(/no absence of liquidity can be inferred/);
  });

  it("still finds a pool at the deployment floor, and reports both sides in the note", async () => {
    const c = mpgrChain();
    const result = await discoverV4Pools(c.client, MPGR, WETH, HEAD, {}, budget);
    expect(result.pools).toHaveLength(1);
    expect(result.floor).toBe(MPGR_DEPLOYED);
    expect(result.scannedTo!).toBeGreaterThanOrEqual(MPGR_DEPLOYED + 1n);
    expect(result.note).toMatch(/from both ends/);
  });

  it("reports complete ONLY when the two sides actually met", async () => {
    // No range cap: one window spans floor..head, so the forward side reaches head and
    // the search is genuinely exhaustive.
    const complete = await discoverV4Pools(
      chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED }, pools: [{ block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey }] }).client,
      MPGR, WETH, HEAD, {}, budget);
    expect(complete.state).toBe("complete");
    expect(complete.scannedTo).toBe(HEAD);
    expect(complete.note).not.toMatch(/were NOT scanned/);
    expect(complete.note).toMatch(/covered blocks \d+-\d+/);

    // A ten-block cap cannot cross the gap, so the same search must not claim complete.
    const capped = await discoverV4Pools(mpgrChain().client, MPGR, WETH, HEAD, {}, budget);
    expect(capped.state).toBe("capped");
    expect(capped.scannedTo!).toBeLessThan(HEAD);
  });

  it("never skips a block inside either side, and never lets the sides overlap", async () => {
    // No pool at all: both sides run until the call budget stops them, which is the
    // worst case for contiguity.
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED }, logRangeCap: 10n });
    const result = await discoverV4Pools(c.client, MPGR, WETH, HEAD, { maxLogCalls: 40 }, budget);
    expect(result.pools).toEqual([]);
    expect(result.state).toBe("capped");
    const { forward, backward, unassigned, top, bottom } = chains(c, MPGR_DEPLOYED, HEAD);
    // Every served range belongs to one contiguous chain: nothing was sampled, and no
    // block inside a side was jumped over.
    expect(unassigned).toEqual([]);
    expect(forward.length).toBeGreaterThan(0);
    expect(backward.length).toBeGreaterThan(0);
    expect(forward[0].from).toBe(MPGR_DEPLOYED);
    expect(backward[0].to).toBe(HEAD);
    for (let i = 1; i < forward.length; i++) expect(forward[i].from).toBe(forward[i - 1].to + 1n);
    for (let i = 1; i < backward.length; i++) expect(backward[i].to).toBe(backward[i - 1].from - 1n);
    // The sides stop before overlapping, so no block is scanned twice either.
    expect(top).toBeLessThan(bottom);
    // The committed edge never claims more than was served. It may claim up to one
    // window LESS, when the budget dies between the two topic queries of one window: a
    // half-read window is deliberately not reported as covered. Understating reach is
    // conservative; overstating it would be a lie about completeness.
    expect(result.scannedTo!).toBeLessThanOrEqual(top);
    expect(top - result.scannedTo!).toBeLessThanOrEqual(10n);
    expect(result.scannedFrom!).toBeGreaterThanOrEqual(bottom);
    expect(result.scannedFrom! - bottom).toBeLessThanOrEqual(10n);
    // And the note names exactly the blocks between the committed edges.
    expect(result.note).toContain(`Blocks ${result.scannedTo! + 1n}-${result.scannedFrom! - 1n} were NOT scanned`);
  });

  it("runs windows concurrently without overshooting the call cap", async () => {
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED }, logRangeCap: 10n });
    const result = await discoverV4Pools(c.client, MPGR, WETH, HEAD, { maxLogCalls: 40, maxConcurrentLogCalls: 4 }, budget);
    // The cap is on calls ISSUED, so it holds under concurrency too. A diagnostic that
    // overstates a bound is itself a lie, and so is one that quietly exceeds it.
    expect(result.logCalls).toBeLessThanOrEqual(40);
    expect(c.concurrency.max).toBeGreaterThan(1);
    expect(c.concurrency.max).toBeLessThanOrEqual(4);
    expect(c.concurrency.live).toBe(0); // nothing left in flight
    expect(result.note).toMatch(/exceeded its 40-call budget|were NOT scanned/);
  });

  it("still works, and stays sequential, when concurrency is set to one", async () => {
    const c = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED }, pools: [{ block: MPGR_DEPLOYED + 1n, key: nativeMpgrKey }], logRangeCap: 10n });
    const result = await discoverV4Pools(c.client, MPGR, WETH, HEAD, { maxConcurrentLogCalls: 1 }, budget);
    expect(c.concurrency.max).toBe(1);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].id).toBe(`${V4_MANAGER.toLowerCase()}:${v4PoolKeyId(nativeMpgrKey).toLowerCase()}`);
  });

  it("reaches further for the same wall clock than a sequential scan of the same budget", async () => {
    // Same call budget, same provider, same token: concurrency must not cost coverage.
    const sequential = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED }, logRangeCap: 10n });
    const parallel = chain({ code: { [MPGR.toLowerCase()]: MPGR_DEPLOYED }, logRangeCap: 10n });
    const a = await discoverV4Pools(sequential.client, MPGR, WETH, HEAD, { maxLogCalls: 40, maxConcurrentLogCalls: 1 }, budget);
    const b = await discoverV4Pools(parallel.client, MPGR, WETH, HEAD, { maxLogCalls: 40, maxConcurrentLogCalls: 4 }, budget);
    expect(a.logCalls).toBe(b.logCalls);
    // Identical reach: parallelism buys wall clock, never a different answer.
    expect(a.scannedTo).toBe(b.scannedTo);
    expect(a.scannedFrom).toBe(b.scannedFrom);
    expect(a.state).toBe(b.state);
    expect(sequential.concurrency.max).toBe(1);
    expect(parallel.concurrency.max).toBeGreaterThan(1);
  });
});
