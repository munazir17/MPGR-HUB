// End-to-end V2 execution preparation against fabricated read-only readers.
// Proves the activated shape works AND that live posture drift fails closed.
// No RPC, no fork, no broadcast: the fork workflow remains the only fork proof.
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { prepareV2Execution, v2IntentId, type V2ExecutionReader } from "../execution";
import { V2PreflightError } from "../preflight";
import { V2_FEE_RECIPIENT, type V2Quote } from "../discovery";
import { SWAP_V2_SEALED_MANIFEST } from "../deployment";
import {
  TOKEN_A, TOKEN_B, WETH, TAKER, POOL_AB, POOL_AB_2, POOL_AC, POOL_CD, POOL_DB, TOKEN_C, TOKEN_D,
  deployment, directQuote, v3Pool, v4Pool, HOOKS,
} from "./helpers";

const BLOCK = { number: 52_900_000n, hash: `0x${"11".repeat(32)}` as Hex, timestamp: 1_760_000_000n };
const u256 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;

const VENUE_REGISTRATION: Record<string, { kind: number; factory: string }> = Object.fromEntries(
  SWAP_V2_SEALED_MANIFEST.venues.map((v) => [v.router.toLowerCase(), { kind: v.kind, factory: v.factory.toLowerCase() }]),
);

interface ReaderOptions {
  chainId?: number;
  code?: Hex | null;
  feeBps?: number;
  maxFeeBps?: number;
  feeRecipient?: Address;
  owner?: Address;
  paused?: boolean;
  timelock?: bigint;
  manager?: Address;
  unregistered?: string;
  /** A proposed-but-unapplied governance fee change; 0 means none. */
  pendingEffectiveAt?: bigint;
  pendingFeeBps?: number;
  /** Value returned by the executor `eth_call` simulation. */
  simulated?: bigint | null;
}

interface SimCall { account: Address; to: Address; data: Hex; value: bigint; blockNumber: bigint }

function fakeReader(options: ReaderOptions = {}): V2ExecutionReader & { calls: number; callArgs: SimCall[] } {
  const state = { calls: 0, callArgs: [] as SimCall[] };
  const o = {
    chainId: 8453, code: "0x6080" as Hex, feeBps: 25, maxFeeBps: 100,
    feeRecipient: V2_FEE_RECIPIENT, owner: SWAP_V2_SEALED_MANIFEST.owner, paused: false,
    timelock: 172_800n, manager: "0x498581fF718922c3f8e6A244956aF099B2652b2b", simulated: 1000n,
    pendingEffectiveAt: 0n, pendingFeeBps: 0,
    ...options,
  };
  return {
    ...state,
    async getChainId() { return o.chainId; },
    async getCode() { return o.code; },
    async readContract(args: { functionName: string; args?: readonly unknown[] }) {
      state.calls++;
      const router = (args.args?.[0] as string | undefined)?.toLowerCase();
      switch (args.functionName) {
        case "feeBps": return o.feeBps;
        case "MAX_FEE_BPS": return o.maxFeeBps;
        case "feeRecipient": return o.feeRecipient;
        case "PINNED_FEE_RECIPIENT": return o.feeRecipient;
        case "owner": return o.owner;
        case "GOVERNANCE_SAFE": return o.owner;
        case "paused": return o.paused;
        case "pendingFeeBps": return o.pendingFeeBps;
        case "pendingFeeRecipient": return o.pendingEffectiveAt === 0n ? "0x0000000000000000000000000000000000000000" : o.feeRecipient;
        case "pendingEffectiveAt": return o.pendingEffectiveAt;
        case "FEE_TIMELOCK_SECONDS": return o.timelock;
        case "V4_POOL_MANAGER": return o.manager;
        case "routerKind": {
          if (router && o.unregistered && router === o.unregistered.toLowerCase()) return 0;
          return VENUE_REGISTRATION[router ?? ""]?.kind ?? 0;
        }
        case "routerFactory": return VENUE_REGISTRATION[router ?? ""]?.factory ?? "0x0000000000000000000000000000000000000000";
        default: throw new Error(`unexpected posture read: ${args.functionName}`);
      }
    },
    async call(args: SimCall) {
      // Recorded so a test can assert WHO the simulation ran as, against WHICH contract,
      // and at WHICH block — none of which a returned value can show.
      state.callArgs.push(args);
      return { data: o.simulated === null ? null : u256(o.simulated) };
    },
  } as unknown as V2ExecutionReader & { calls: number; callArgs: SimCall[] };
}

const request = (quote: V2Quote, extra: Partial<Parameters<typeof prepareV2Execution>[2]> = {}) => ({
  quote, taker: TAKER as Address, slippageBps: 100, deadline: 9_999_999_999n,
  nativeIn: false, nativeOut: false, ...extra,
});

/** A two-leg split quote for the same arbitrary pair, one fee on gross. */
function splitQuote(): V2Quote {
  const gross = 1_000_000n, fee = 2500n, net = gross - fee;
  return {
    tokenIn: TOKEN_A, tokenOut: TOKEN_B, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net,
    amountOut: 2000n,
    legs: [
      { pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)], tokens: [TOKEN_A, TOKEN_B], amountIn: 500_000n, amountOut: 1000n },
      { pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB_2, 3000)], tokens: [TOKEN_A, TOKEN_B], amountIn: net - 500_000n, amountOut: 1000n },
    ],
  };
}

/** A genuine three-hop quote through two NON-major intermediates (no WETH/USDC). */
function threeHopQuote(): V2Quote {
  const gross = 1_000_000n, fee = 2500n, net = gross - fee;
  return {
    tokenIn: TOKEN_A, tokenOut: TOKEN_B, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net,
    amountOut: 900n,
    legs: [{
      // A -> C -> D -> B. Neither intermediate is WETH or USDC, and no catalog
      // veto applies: this is exactly the "any two distinct Base tokens" case.
      pools: [v3Pool(TOKEN_A, TOKEN_C, POOL_AC), v3Pool(TOKEN_C, TOKEN_D, POOL_CD), v3Pool(TOKEN_B, TOKEN_D, POOL_DB)],
      tokens: [TOKEN_A, TOKEN_C, TOKEN_D, TOKEN_B], amountIn: net, amountOut: 900n,
    }],
  };
}

describe("prepareV2Execution — activated shape", () => {
  it("returns an executable transaction for an arbitrary imported pair", async () => {
    const swap = await prepareV2Execution(fakeReader(), deployment, request(directQuote()), BLOCK);
    expect(swap.executor).toBe(deployment.executor);
    expect(swap.spender).toBe(deployment.executor); // approval spender == executor
    expect(swap.transaction.to).toBe(deployment.executor);
    expect(swap.transaction.value).toBe(0n);
    expect(swap.entry).toBe("swapExactInput");
    expect(swap.fee).toBe(2500n);
    expect(swap.feeBps).toBe(25);
    expect(swap.feeRecipient.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(swap.quotedOut).toBe(1000n);
    expect(swap.minimum).toBe(990n); // 1000 less 100 bps slippage
    expect(swap.intent.amountOutMinimum).toBe(990n);
    expect(swap.executionSimulation).toBe("eth-call-succeeded-no-settlement-proof");
    expect(swap.blockNumber).toBe(BLOCK.number);
    expect(swap.blockHash).toBe(BLOCK.hash);
    expect(swap.posture.paused).toBe(false);
  });

  it("builds a split transaction that charges the fee once on gross", async () => {
    const swap = await prepareV2Execution(fakeReader({ simulated: 2000n }), deployment, request(splitQuote()), BLOCK);
    expect(swap.entry).toBe("swapExactInputSplit");
    expect(swap.fee).toBe(2500n);
    expect(swap.intent.legAmounts.reduce((a, b) => a + b, 0n)).toBe(997_500n); // net, never gross
    expect(swap.intent.paths).toHaveLength(2);
  });

  it("builds a three-hop route through non-major intermediates", async () => {
    const swap = await prepareV2Execution(fakeReader({ simulated: 900n }), deployment, request(threeHopQuote()), BLOCK);
    expect(swap.intent.hops).toBe(3);
    expect(swap.intent.paths[0].map((h) => h.tokenOut.toLowerCase())).toEqual([TOKEN_C, TOKEN_D, TOKEN_B]);
  });

  it("simulates as the taker, against only the sealed executor, at the pinned block", async () => {
    const reader = fakeReader();
    await prepareV2Execution(reader, deployment, request(directQuote()), BLOCK);
    expect(reader.callArgs).toHaveLength(1);
    const sim = reader.callArgs[0];
    // As the TAKER: a simulation from any other address proves nothing about this swap,
    // because allowances, balances and the fee path are all taker-specific.
    expect(sim.account.toLowerCase()).toBe(TAKER.toLowerCase());
    expect(sim.account.toLowerCase()).not.toBe(deployment.executor.toLowerCase());
    // Against ONLY the sealed executor — the address the calldata will actually target.
    expect(sim.to.toLowerCase()).toBe("0x4be1154440b26145d76608d41d403a33e76b9d0a");
    expect(sim.to.toLowerCase()).toBe(deployment.executor.toLowerCase());
    // At the pinned block, so the answer cannot drift between quote and simulation.
    expect(sim.blockNumber).toBe(BLOCK.number);
    expect(sim.value).toBe(0n);
  });

  it("targets only the executor even when the route addresses a different contract", async () => {
    // A v4 hop's pool, router and factory are all the PoolManager, and the calldata
    // encodes that PoolKey — but the transaction is still sent to the executor and
    // nowhere else. The executor is the only contract this path ever calls.
    const gross = 1_000_000n, fee = 2500n, net = gross - fee;
    const quote: V2Quote = {
      tokenIn: TOKEN_A, tokenOut: TOKEN_B, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net, amountOut: 1000n,
      legs: [{ pools: [v4Pool(TOKEN_A, TOKEN_B, 3000, 60, HOOKS)], tokens: [TOKEN_A, TOKEN_B], amountIn: net, amountOut: 1000n }],
    };
    const reader = fakeReader();
    const swap = await prepareV2Execution(reader, deployment, request(quote), BLOCK);
    expect(swap.transaction.to.toLowerCase()).toBe("0x4be1154440b26145d76608d41d403a33e76b9d0a");
    expect(reader.callArgs[0].to.toLowerCase()).toBe("0x4be1154440b26145d76608d41d403a33e76b9d0a");
    // The hop still addresses the PoolManager inside the calldata, which is the point:
    // routing target and transaction target are deliberately different things.
    expect(swap.intent.paths[0][0].pool.toLowerCase()).toBe("0x498581ff718922c3f8e6a244956af099b2652b2b");
    expect(swap.transaction.to.toLowerCase()).not.toBe(swap.intent.paths[0][0].pool.toLowerCase());
  });

  it("builds a v4 route through the canonical PoolManager", async () => {
    const gross = 1_000_000n, fee = 2500n, net = gross - fee;
    const quote: V2Quote = {
      tokenIn: TOKEN_A, tokenOut: TOKEN_B, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net, amountOut: 1000n,
      legs: [{ pools: [v4Pool(TOKEN_A, TOKEN_B, 3000, 60, HOOKS)], tokens: [TOKEN_A, TOKEN_B], amountIn: net, amountOut: 1000n }],
    };
    const swap = await prepareV2Execution(fakeReader(), deployment, request(quote), BLOCK);
    expect(swap.intent.routerKind).toBe(7);
    expect(swap.intent.paths[0][0].pool.toLowerCase()).toBe("0x498581ff718922c3f8e6a244956af099b2652b2b");
    expect(swap.intent.paths[0][0].v4Key?.tickSpacing).toBe(60);
  });

  it("builds a native ETH sell with value equal to gross through a v4 native PoolKey", async () => {
    const gross = 1_000_000n, fee = 2500n, net = gross - fee;
    const quote: V2Quote = {
      tokenIn: WETH, tokenOut: TOKEN_B, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net, amountOut: 1000n,
      legs: [{ pools: [v4Pool("0x0000000000000000000000000000000000000000", TOKEN_B, 0, 200, HOOKS)], tokens: [WETH, TOKEN_B], amountIn: net, amountOut: 1000n }],
    };
    const swap = await prepareV2Execution(fakeReader(), deployment, request(quote, { nativeIn: true }), BLOCK);
    expect(swap.transaction.value).toBe(gross);
    expect(swap.intent.nativeIn).toBe(true);
    expect(swap.intent.tokenIn.toLowerCase()).toBe(WETH.toLowerCase());
  });

  it("binds a deterministic intent id to the quote, taker and pinned block", async () => {
    const quote = directQuote();
    const id = v2IntentId(deployment, quote, TAKER, 100, BLOCK);
    const swap = await prepareV2Execution(fakeReader(), deployment, request(quote), BLOCK);
    expect(swap.intentId).toBe(id);
    expect(swap.intent.intentId).toBe(id);
    // A different amount, taker or block must produce a different id.
    expect(v2IntentId(deployment, directQuote({ gross: 2_000_000n }), TAKER, 100, BLOCK)).not.toBe(id);
    expect(v2IntentId(deployment, quote, POOL_AB, 100, BLOCK)).not.toBe(id);
    expect(v2IntentId(deployment, quote, TAKER, 100, { number: BLOCK.number + 1n, hash: BLOCK.hash })).not.toBe(id);
  });

  it("quotes at the current 25 bps while a fee change is still inside its timelock, and surfaces it", async () => {
    const effectiveAt = BLOCK.timestamp + 100_000n;
    const swap = await prepareV2Execution(fakeReader({ pendingEffectiveAt: effectiveAt, pendingFeeBps: 30 }), deployment, request(directQuote()), BLOCK);
    expect(swap.feeBps).toBe(25); // the governed fee, not the pending one
    expect(swap.fee).toBe(2500n);
    expect(swap.posture.pendingFeeBps).toBe(30);
    expect(swap.posture.pendingEffectiveAt).toBe(effectiveAt);
  });

  it("refuses to return a transaction the executor simulation does not satisfy", async () => {
    await expect(prepareV2Execution(fakeReader({ simulated: 989n }), deployment, request(directQuote()), BLOCK))
      .rejects.toThrow(/minimum/i);
    await expect(prepareV2Execution(fakeReader({ simulated: null }), deployment, request(directQuote()), BLOCK))
      .rejects.toThrow(/no data/i);
  });
});

describe("prepareV2Execution — fail-closed on live posture drift", () => {
  const expectCode = async (options: ReaderOptions, code: string) => {
    await expect(prepareV2Execution(fakeReader(options), deployment, request(directQuote()), BLOCK)).rejects.toSatisfy(
      (error: unknown) => error instanceof V2PreflightError && error.code === code,
    );
  };

  it("rejects a paused executor", () => expectCode({ paused: true }, "EXECUTOR_PAUSED"));
  // Once the timelock has elapsed, governance can apply the new fee in any
  // block, so the sealed 25 bps invariant is no longer guaranteed.
  it("rejects a governance fee change whose timelock has already elapsed", () =>
    expectCode({ pendingEffectiveAt: BLOCK.timestamp - 1n, pendingFeeBps: 30 }, "PENDING_FEE_CHANGE"));
  it("rejects a fee change that becomes effective exactly at the pinned block", () =>
    expectCode({ pendingEffectiveAt: BLOCK.timestamp, pendingFeeBps: 30 }, "PENDING_FEE_CHANGE"));
  it("rejects a governed fee that drifted from the sealed 25 bps", () => expectCode({ feeBps: 26 }, "FEE_POLICY_INVALID"));
  it("rejects a fee cap that is no longer 100 bps", () => expectCode({ maxFeeBps: 500 }, "FEE_POLICY_INVALID"));
  it("rejects a timelock that is no longer 172800 seconds", () => expectCode({ timelock: 0n }, "FEE_POLICY_INVALID"));
  it("rejects a redirected fee recipient", () => expectCode({ feeRecipient: TOKEN_A }, "FEE_RECIPIENT_CHANGED"));
  it("rejects an executor not owned by the governance Safe", () => expectCode({ owner: SWAP_V2_SEALED_MANIFEST.deployer }, "OWNER_CHANGED"));
  it("rejects a non-Base chain", () => expectCode({ chainId: 1 }, "UNSUPPORTED_NETWORK"));
  it("rejects an executor with no runtime code at the pinned block", () => expectCode({ code: "0x" }, "EXECUTOR_NOT_DEPLOYED"));
  it("rejects a v4 PoolManager pin that is not canonical", () => expectCode({ manager: POOL_AB }, "VENUE_NOT_REGISTERED"));
  it("rejects a venue that governance de-registered on-chain", () =>
    expectCode({ unregistered: SWAP_V2_SEALED_MANIFEST.venues[0].router }, "VENUE_NOT_REGISTERED"));

  it("treats an unreadable executor as retryable, never as 'no liquidity'", async () => {
    const reader = fakeReader();
    (reader as unknown as { readContract: () => Promise<unknown> }).readContract = async () => { throw new Error("429 over rate limit"); };
    await expect(prepareV2Execution(reader, deployment, request(directQuote()), BLOCK)).rejects.toSatisfy(
      (error: unknown) => error instanceof V2PreflightError && error.code === "ROUTE_VERIFICATION_UNAVAILABLE" && error.status === 503,
    );
  });
});
