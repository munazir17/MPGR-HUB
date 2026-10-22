// app/api/swap/v2/quote/route.staged.integration.test.ts
//
// EVIDENCE TIER — SIMULATED. The chain below is a fabricated in-process reader; no RPC was
// contacted and nothing was signed or broadcast.
//
// WHY THIS FILE EXISTS SEPARATELY. `route.test.ts` and `route.activation.test.ts` both mock
// discovery, so they prove the HTTP boundary and the activated shape but never the two
// together with real routing. This is the acceptance criterion, driven end to end through
// the real code: a pasted pair whose pool a FACTORY GETTER knows about must come back from
// ONE `POST /api/swap/v2/quote` as a simulated V2 transaction aimed at the sealed executor —
// without a single `eth_getLogs`, because on a provider that serves ten blocks per query a
// single log scan is the difference between a quote and a timeout.
//
// Discovery, the staged source, the fee invariant, calldata construction, posture
// verification and the simulation are all the real modules. Only the HTTP edge (auth,
// origin, rate limit, request parsing) and the chain itself are fabricated.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { SWAP_V2_SEALED_MANIFEST, __setSwapV2ExecutorForTests } from "@/lib/swap/v2/deployment";
import { V2_FEE_RECIPIENT } from "@/lib/swap/v2/discovery";
import { POST } from "./route";

vi.mock("@/lib/auth/session-store", () => ({ authenticateRequest: async () => ({ wallet: TAKER }) }));
vi.mock("@/lib/api/request-guard", () => ({ verifyTrustedOrigin: () => null, readJsonBody: async (r: Request) => ({ ok: true, value: await r.json() }) }));
vi.mock("@/lib/trade/trade-rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), clientIpFromRequest: () => "test" }));
vi.mock("@/lib/trade/trade-request", () => ({ parseTradeSwapRequest: async () => ({
  ok: true,
  value: { from: { address: TOKEN_A }, to: { address: TOKEN_B }, fromAmount: String(GROSS), taker: TAKER, slippageBps: 100 },
}) }));
vi.mock("@/lib/trade/trade-public-client", () => ({ getTradePublicClient: () => chain.client }));

const TAKER = "0x0000000000000000000000000000000000000123" as Address;
const TOKEN_A = "0x0000000000000000000000000000000000000a01" as Address;
const TOKEN_B = "0x0000000000000000000000000000000000000b02" as Address;
const POOL = "0x0000000000000000000000000000000000000c03" as Address;
const GROSS = 10_000n;
const QUOTED_OUT = 1_000n;
const BLOCK = { number: 52_900_000n, hash: `0x${"12".repeat(32)}` as Hex, timestamp: 1_760_000_000n };
const EXECUTOR = SWAP_V2_SEALED_MANIFEST.executor;
const V3 = SWAP_V2_SEALED_MANIFEST.venues.find((v) => v.kind === 2)!;
const V3_FEE = 3000;
const RANGE_REFUSAL = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.";
const u256 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const addr = (value: string): Hex => encodeAbiParameters([{ type: "address" }], [value as Address]);

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

const VENUE_BY_ROUTER: Record<string, { kind: number; factory: string }> = Object.fromEntries(
  SWAP_V2_SEALED_MANIFEST.venues.map((v) => [v.router.toLowerCase(), { kind: v.kind, factory: v.factory.toLowerCase() }]),
);

/** The fabricated chain. `calls.getLogs` is the number this whole file is about. */
const chain = (() => {
  const calls = { getLogs: 0, getCode: 0, call: 0, readContract: 0, simulated: QUOTED_OUT as bigint | null, simAccount: "" as string };
  const decode = (data: Hex) => {
    for (const abi of [factories, slipFactory, props, v3Quoter]) {
      try { return decodeFunctionData({ abi, data }) as unknown as { functionName: string; args: readonly unknown[] }; } catch { /* next ABI */ }
    }
    return null;
  };
  const client = {
    async getChainId() { return 8453; },
    async getBlock() { return BLOCK; },
    async getCode() { calls.getCode++; return "0x60806040" as Hex; },
    async getLogs() {
      calls.getLogs++;
      throw new Error(RANGE_REFUSAL);
    },
    async readContract(args: { address: Address; functionName: string; args?: readonly unknown[] }) {
      calls.readContract++;
      const router = (args.args?.[0] as string | undefined)?.toLowerCase();
      switch (args.functionName) {
        case "feeBps": return 25;
        case "MAX_FEE_BPS": return 100;
        case "feeRecipient": case "PINNED_FEE_RECIPIENT": return V2_FEE_RECIPIENT;
        case "owner": case "GOVERNANCE_SAFE": return SWAP_V2_SEALED_MANIFEST.owner;
        case "paused": return false;
        case "pendingFeeBps": return 0;
        case "pendingFeeRecipient": return zeroAddress;
        case "pendingEffectiveAt": return 0n;
        case "FEE_TIMELOCK_SECONDS": return 172_800n;
        case "V4_POOL_MANAGER": return SWAP_V2_SEALED_MANIFEST.venues.find((v) => v.kind === 7)!.router;
        case "routerKind": return VENUE_BY_ROUTER[router ?? ""]?.kind ?? 0;
        case "routerFactory": return VENUE_BY_ROUTER[router ?? ""]?.factory ?? zeroAddress;
        default: throw new Error(`unexpected posture read: ${args.functionName}`);
      }
    },
    async call(query: { to?: string; data?: Hex; account?: Address }) {
      calls.call++;
      const to = String(query.to ?? "").toLowerCase();
      // The executor simulation: this is the only call the taker's own balance and
      // allowance matter to, so it is the only one that arrives with an `account`.
      if (to === EXECUTOR.toLowerCase()) {
        // Recorded rather than asserted here: an assertion inside a mock surfaces as an
        // opaque 503 instead of a readable failure.
        calls.simAccount = String(query.account ?? "").toLowerCase();
        return { data: calls.simulated === null ? null : u256(calls.simulated) };
      }
      const fn = decode(query.data ?? "0x");
      if (!fn) return { data: u256(0n) };
      if (fn.functionName === "getPool" && to === V3.factory.toLowerCase() && Number(fn.args[2]) === V3_FEE) return { data: addr(POOL) };
      if (fn.functionName === "getPair" || fn.functionName === "getPool") return { data: addr(zeroAddress) };
      if (to === POOL.toLowerCase()) {
        switch (fn.functionName) {
          case "factory": return { data: addr(V3.factory) };
          case "token0": return { data: addr(TOKEN_A) };
          case "token1": return { data: addr(TOKEN_B) };
          case "fee": return { data: encodeAbiParameters([{ type: "uint24" }], [V3_FEE]) };
          case "tickSpacing": return { data: encodeAbiParameters([{ type: "int24" }], [60]) };
          default: return { data: encodeAbiParameters([{ type: "bool" }], [false]) };
        }
      }
      if (fn.functionName === "quoteExactInputSingle") {
        const params = fn.args[0] as { amountIn: bigint };
        // A venue that answers proportionally, so the fee really was taken out of gross
        // before the leg was quoted.
        return { data: encodeAbiParameters([{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }], [(params.amountIn * QUOTED_OUT) / (GROSS - GROSS * 25n / 10_000n), 0n, 0, 0n]) };
      }
      return { data: u256(0n) };
    },
  };
  return { client: client as never, calls };
})();

const post = () => POST(new Request("https://mpgr.test/api/swap/v2/quote", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fromToken: TOKEN_A, toToken: TOKEN_B, fromAmount: String(GROSS) }),
}));

beforeEach(() => { chain.calls.getLogs = 0; chain.calls.getCode = 0; chain.calls.call = 0; chain.calls.readContract = 0; chain.calls.simulated = QUOTED_OUT; chain.calls.simAccount = ""; });
afterEach(() => __setSwapV2ExecutorForTests(null));

describe("one paste, one quote, one simulated V2 transaction", () => {
  it("returns an executable transaction for a getter-discovered pool without any eth_getLogs", async () => {
    __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, never> & {
      executable: boolean; preview: boolean; transaction: { to: string; data: string; value: string } | null;
      executor: string; spender: string; entry: string; fee: string; feeBps: number; feeRecipient: string;
      toAmount: string; minToAmount: string; hops: number; executionSimulation: string;
      quote: { gross: string; fee: string; net: string; amountOut: string; legs: { pools: { kind: number; pool: string }[] }[] };
    };

    // The acceptance criterion: a simulated, sendable V2 transaction from ONE request.
    expect(body.executable).toBe(true);
    expect(body.preview).toBe(false);
    expect(body.transaction).not.toBeNull();
    expect(body.transaction!.to.toLowerCase()).toBe("0x4be1154440b26145d76608d41d403a33e76b9d0a");
    expect(body.executor.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(body.spender.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(body.entry).toBe("swapExactInput");
    expect(body.executionSimulation).not.toBe("not-run-unreleased");
    expect(body.transaction!.data.length).toBeGreaterThan(10);
    // Simulated as the TAKER at the pinned block, not as the executor or as nobody.
    expect(chain.calls.simAccount).toBe(TAKER.toLowerCase());

    // THE POINT: the pool came from a factory getter, so nothing scanned the chain.
    expect(chain.calls.getLogs).toBe(0);
    expect(chain.calls.call).toBeGreaterThan(0);

    // Real routing, not a stubbed quote: the leg is the v3 pool the getter named.
    expect(body.quote.legs).toHaveLength(1);
    expect(body.quote.legs[0].pools).toHaveLength(1);
    expect(body.quote.legs[0].pools[0].kind).toBe(2);
    expect(body.quote.legs[0].pools[0].pool.toLowerCase()).toBe(POOL.toLowerCase());
    expect(body.hops).toBe(1);

    // The 25 bps fee, once, on gross, to the pinned treasury.
    expect(body.quote.gross).toBe(GROSS.toString());
    expect(body.quote.fee).toBe((GROSS * 25n / 10_000n).toString());
    expect(body.quote.net).toBe((GROSS - GROSS * 25n / 10_000n).toString());
    expect(body.fee).toBe((GROSS * 25n / 10_000n).toString());
    expect(body.feeBps).toBe(25);
    expect(body.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(body.toAmount).toBe(QUOTED_OUT.toString());
    expect(BigInt(body.minToAmount)).toBeLessThan(QUOTED_OUT);
  });

  it("returns no transaction when the simulation misses the committed minimum", async () => {
    __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
    chain.calls.simulated = 1n; // the venue answered, but the executor would not deliver
    const response = await post();
    expect(response.status).toBe(503);
    const body = await response.json() as { code: string; transaction?: unknown };
    expect(body.code).toBe("EXECUTION_UNAVAILABLE");
    expect(body.transaction).toBeUndefined();
    expect(chain.calls.getLogs).toBe(0);
  });

  it("returns no transaction when the executor simulation reverts", async () => {
    __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST);
    chain.calls.simulated = null;
    const response = await post();
    expect(response.status).toBe(503);
    expect((await response.json() as { transaction?: unknown }).transaction).toBeUndefined();
  });

  it("stays fast and stays dormant when the gate is not activated", async () => {
    // Rollback shape: the same paste, the same zero log calls, and no transaction at all.
    __setSwapV2ExecutorForTests(null);
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json() as { preview: boolean; executable: boolean; transaction: unknown; executionSimulation: string };
    expect(body).toMatchObject({ preview: true, executable: false, transaction: null, executionSimulation: "not-run-unreleased" });
    expect(chain.calls.getLogs).toBe(0);
    // Discovery still ran, so the quote in the preview is a real routed quote.
    expect(chain.calls.call).toBeGreaterThan(0);
  });
});
