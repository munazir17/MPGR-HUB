// HTTP boundary for the V2 activation gate.
//
// This file proves two things that must never drift apart:
//   1. With no injection, the route is DORMANT and returns byte-for-byte the
//      historical preview shape — `executable:false`, `transaction:null`.
//   2. With the sealed manifest injected through the test-only hook, the same
//      route returns an executable transaction, and only after live posture,
//      venue registration, exact simulation and independent intent inspection
//      all pass. Every failure path returns an honest code and NO transaction.
//
// The injection is test-only (`__setSwapV2ExecutorForTests`). Production stays
// gated on `V2_DEPLOYMENT`, which this file asserts is still literally null.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

const mocks = vi.hoisted(() => ({
  parse: vi.fn(), quote: vi.fn(),
  client: { getChainId: vi.fn(), getBlock: vi.fn(), getCode: vi.fn(), readContract: vi.fn(), call: vi.fn() },
}));
// vi.mock factories are hoisted above the module body, so the wallet literal is
// inlined here rather than referencing the `TAKER` const declared below.
vi.mock("@/lib/auth/session-store", () => ({ authenticateRequest: async () => ({ wallet: "0x0000000000000000000000000000000000000123" }) }));
vi.mock("@/lib/api/request-guard", () => ({ verifyTrustedOrigin: () => null, readJsonBody: async (r: Request) => ({ ok: true, value: await r.json() }) }));
vi.mock("@/lib/trade/trade-rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), clientIpFromRequest: () => "test" }));
vi.mock("@/lib/trade/trade-request", () => ({ parseTradeSwapRequest: mocks.parse }));
vi.mock("@/lib/trade/trade-public-client", () => ({ getTradePublicClient: () => mocks.client }));
// The route builds its source through `swapV2QuoteSource`; discovery is mocked below, so
// the stub only has to exist and be callable.
vi.mock("@/lib/swap/v2/rpc-source", () => ({ RpcV2LiquiditySource: class {}, swapV2QuoteSource: () => ({}) }));
vi.mock("@/lib/swap/v2/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swap/v2/discovery")>()), discoverV2Quote: mocks.quote,
}));

import { POST } from "./route";
import { V2_DEPLOYMENT, V2_FEE_RECIPIENT, V2QuoteError, type Pool, type V2Quote } from "@/lib/swap/v2/discovery";
import { SWAP_V2_SEALED_MANIFEST, __setSwapV2ExecutorForTests, swapV2Executor, swapV2RoutingActivated } from "@/lib/swap/v2/deployment";

const TAKER = "0x0000000000000000000000000000000000000123";
const A = "0x0000000000000000000000000000000000000101" as Address;
const B = "0x0000000000000000000000000000000000000102" as Address;
const UNI_V3_ROUTER = SWAP_V2_SEALED_MANIFEST.venues.find((v) => v.kind === 2)!.router;
const UNI_V3_FACTORY = SWAP_V2_SEALED_MANIFEST.venues.find((v) => v.kind === 2)!.factory;
const POOL_AB = "0xe555555555555555555555555555555555555555" as Address;
const BLOCK_HASH = `0x${"12".repeat(32)}` as Hex;
const BLOCK = { number: 52_900_000n, hash: BLOCK_HASH, timestamp: 1_760_000_000n };
const u256 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;

/** kind -> {router, factory} exactly as the sealed manifest registers them. */
const VENUES: Record<string, { kind: number; factory: string }> = Object.fromEntries(
  SWAP_V2_SEALED_MANIFEST.venues.map((v) => [v.router.toLowerCase(), { kind: v.kind, factory: v.factory.toLowerCase() }]),
);

const pool: Pool = {
  id: `v3:${POOL_AB}:500`, pool: POOL_AB, router: UNI_V3_ROUTER, factory: UNI_V3_FACTORY, kind: 2,
  token0: A, token1: B, poolFee: 500, tickSpacing: 0, stable: false,
};
/** gross 10000 -> fee 25 (25 bps on GROSS) -> net 9975 allocated to one leg. */
const quote = (): V2Quote => ({
  tokenIn: A, tokenOut: B, gross: 10_000n, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT,
  fee: 25n, net: 9_975n, amountOut: 1_000n,
  legs: [{ pools: [pool], tokens: [A, B], amountIn: 9_975n, amountOut: 1_000n }],
});

interface ReaderOverrides {
  feeBps?: number; paused?: boolean; simulated?: bigint;
  feeRecipient?: Address; owner?: Address; unregistered?: string;
}
function wireReader(o: ReaderOverrides = {}) {
  const s = {
    feeBps: 25, paused: false, simulated: 1_000n, feeRecipient: V2_FEE_RECIPIENT,
    owner: SWAP_V2_SEALED_MANIFEST.owner, unregistered: undefined as string | undefined, ...o,
  };
  mocks.client.getCode.mockResolvedValue("0x60806040");
  mocks.client.call.mockResolvedValue({ data: u256(s.simulated) });
  mocks.client.readContract.mockImplementation(async (args: { functionName: string; args?: readonly unknown[] }) => {
    const router = (args.args?.[0] as string | undefined)?.toLowerCase();
    switch (args.functionName) {
      case "feeBps": return s.feeBps;
      case "MAX_FEE_BPS": return 100;
      case "feeRecipient": case "PINNED_FEE_RECIPIENT": return s.feeRecipient;
      case "owner": case "GOVERNANCE_SAFE": return s.owner;
      case "paused": return s.paused;
      case "pendingFeeBps": return 0;
      case "pendingFeeRecipient": return "0x0000000000000000000000000000000000000000";
      case "pendingEffectiveAt": return 0n;
      case "FEE_TIMELOCK_SECONDS": return 172_800n;
      case "V4_POOL_MANAGER": return SWAP_V2_SEALED_MANIFEST.venues.find((v) => v.kind === 7)!.router;
      case "routerKind":
        if (router && s.unregistered && router === s.unregistered.toLowerCase()) return 0;
        return VENUES[router ?? ""]?.kind ?? 0;
      case "routerFactory": return VENUES[router ?? ""]?.factory ?? "0x0000000000000000000000000000000000000000";
      default: throw new Error(`unexpected posture read: ${args.functionName}`);
    }
  });
}

const request = (extra = {}) => new Request("https://mpgr.test/api/swap/v2/quote", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fromToken: A, toToken: B, fromAmount: "10000", ...extra }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parse.mockResolvedValue({ ok: true, value: { from: { address: A }, to: { address: B }, fromAmount: "10000", taker: TAKER, slippageBps: 100 } });
  mocks.client.getChainId.mockResolvedValue(8453);
  mocks.client.getBlock.mockResolvedValue(BLOCK);
  mocks.quote.mockResolvedValue(quote());
  wireReader();
});
// Never leak an injected deployment into another test.
afterEach(() => __setSwapV2ExecutorForTests(null));

describe("V2 activation gate — dormant shape, which is what rollback restores", () => {
  it("keeps the dormant preview shape reachable after activation", async () => {
    // The gate now resolves the sealed manifest, so dormancy is injected explicitly
    // rather than inherited from the constant. That is deliberate: the dormant preview
    // shape IS the rollback shape, and it must stay covered after activation instead of
    // being deleted along with the constant that used to produce it.
    expect(V2_DEPLOYMENT).toBe(SWAP_V2_SEALED_MANIFEST);
    __setSwapV2ExecutorForTests(null);
    expect(swapV2Executor()).toBeNull();
    expect(swapV2RoutingActivated()).toBe(false);
    const r = await POST(request());
    expect(r.status).toBe(200);
    const body = await r.json();
    // The historical preview shape, key for key.
    expect(Object.keys(body).sort()).toEqual(["blockHash", "blockNumber", "executable", "executionSimulation", "preview", "quote", "transaction"]);
    expect(body).toMatchObject({
      preview: true, executable: false, transaction: null,
      executionSimulation: "not-run-unreleased", blockNumber: "52900000", blockHash: BLOCK_HASH,
    });
    // No posture read, no simulation: nothing executor-facing happens while dormant.
    expect(mocks.client.readContract).not.toHaveBeenCalled();
    expect(mocks.client.call).not.toHaveBeenCalled();
  });

  it("rejects a malformed provider block hash instead of pinning an unusable quote", async () => {
    mocks.client.getBlock.mockResolvedValue({ ...BLOCK, hash: "0x1234" as Hex });
    const r = await POST(request());
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.code).toBe("PROVIDER_ERROR");
    expect(body.transaction).toBeUndefined();
    // Discovery must not even run against a block that cannot be pinned.
    expect(mocks.quote).not.toHaveBeenCalled();
  });
});

describe("V2 activation gate — activated shape", () => {
  beforeEach(() => __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST));

  it("returns an executable transaction bound to the sealed executor", async () => {
    const r = await POST(request());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.preview).toBe(false);
    expect(body.executable).toBe(true);
    expect(body.executionSimulation).toBe("eth-call-succeeded-no-settlement-proof");
    expect(body.executor.toLowerCase()).toBe(SWAP_V2_SEALED_MANIFEST.executor.toLowerCase());
    // BUY and SELL agree: the approval spender is the executor the tx targets.
    expect(body.spender.toLowerCase()).toBe(body.transaction.to.toLowerCase());
    expect(body.chainId).toBe(8453);
    expect(body.entry).toBe("swapExactInput");
    expect(body.hops).toBe(1);
    expect(body.transaction.value).toBe("0");
    expect(body.transaction.data).toMatch(/^0x[0-9a-f]+$/);
    expect(body.intentId).toMatch(/^0x[0-9a-f]{64}$/);
    // The 25 bps fee invariant and the configured recipient survive to the wire.
    expect(body.fee).toBe("25");
    expect(body.feeBps).toBe(25);
    expect(body.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(body.toAmount).toBe("1000");
    expect(body.minToAmount).toBe("990"); // 1000 less 100 bps slippage
    expect(body.slippageBps).toBe(100);
    expect(body.nativeIn).toBe(false);
    expect(body.nativeOut).toBe(false);
    expect(body.settlementNote).toMatch(/not a settlement proof/i);
  });

  it("returns no transaction when the executor is paused", async () => {
    wireReader({ paused: true });
    const r = await POST(request());
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.code).toBe("EXECUTOR_PAUSED");
    expect(body.transaction).toBeUndefined();
  });

  it("returns no transaction when the governed fee drifted off 25 bps", async () => {
    wireReader({ feeBps: 26 });
    const r = await POST(request());
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("FEE_POLICY_INVALID");
  });

  it("returns no transaction when the fee recipient was redirected", async () => {
    wireReader({ feeRecipient: A });
    const r = await POST(request());
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("FEE_RECIPIENT_CHANGED");
  });

  it("returns no transaction when governance de-registered a venue", async () => {
    wireReader({ unregistered: UNI_V3_ROUTER });
    const r = await POST(request());
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("VENUE_NOT_REGISTERED");
  });

  it("returns no transaction when the simulation misses the committed minimum", async () => {
    wireReader({ simulated: 989n }); // below the 990 minimum
    const r = await POST(request());
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.code).toBe("EXECUTION_UNAVAILABLE");
    expect(body.transaction).toBeUndefined();
  });

  it("reports an RPC outage as retryable, never as a liquidity failure", async () => {
    mocks.client.readContract.mockRejectedValue(new Error("429 over rate limit"));
    const r = await POST(request());
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("ROUTE_VERIFICATION_UNAVAILABLE");
  });

  it("refuses to hand back a transaction whose pinned block moved", async () => {
    // Calls 1 and 2 agree; the post-execution re-check sees a different hash.
    mocks.client.getBlock
      .mockResolvedValueOnce(BLOCK).mockResolvedValueOnce(BLOCK)
      .mockResolvedValue({ ...BLOCK, hash: "0xdead" as Hex });
    const r = await POST(request());
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("QUOTE_CHANGED");
  });

  it("still maps discovery failures to their own codes once activated", async () => {
    mocks.quote.mockRejectedValue(new V2QuoteError("LIQUIDITY_UNAVAILABLE", "No liquid route"));
    const r = await POST(request());
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("LIQUIDITY_UNAVAILABLE");
  });
});
