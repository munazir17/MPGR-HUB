// lib/mcp/__tests__/canary-reader-gateway-quote.test.ts
//
// GATEWAY-LEVEL REGRESSION (offline, mocked — no network, no keys, no
// broadcast) for the armed-Mainnet-canary pre-sign failure:
//
//   viem 2.x `simulateContract()` returns { result, request }. The canary/fork
//   harness readers used to DOUBLE-wrap it, so quoteSlipstream indexed [0] on
//   the wrapper object and silently returned `undefined` -> TypeError at
//   mcp-trade-service `expectedBuyAmount: expected.toString()` (line 451).
//
// These tests drive the REAL McpTradeGateway -> getQuote -> quoteExecutor path
// with a client shaped EXACTLY like viem 2.56.3:
//   1. corrected (single-wrap) reader  -> ok:true, numeric expected/minOut/fee
//   2. the historical double-wrap bug  -> clean structured QUOTE_FAILED
//      (defense-in-depth guard), goal stays ACTIVE, nothing broadcast.

import { describe, expect, it } from "vitest";
import { McpTradeGateway } from "@/lib/autonomy/mcp-gateway";
import type { ChainReader } from "@/lib/executor/executor-chain";
import {
  BASE_MAINNET_EXECUTOR_DEPLOYMENT,
  BASE_MAINNET_USDC,
  MPGR_EXECUTOR_DEPLOYMENTS,
} from "@/lib/executor/executor-config";
import type { Address } from "viem";

const AAPLc = BASE_MAINNET_EXECUTOR_DEPLOYMENT.tokens.find((t) => t.symbol === "AAPLc")!.address as Address;
const OWNER = BASE_MAINNET_EXECUTOR_DEPLOYMENT.owner as Address;
const FEE_RECIPIENT = BASE_MAINNET_EXECUTOR_DEPLOYMENT.feeRecipient as Address;

// Aerodrome Slipstream QuoterV2.quoteExactInputSingle outputs, delivered by
// viem 2.56.3 inside { result, request }:
// [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate]
const QUOTER_RESULT = [987_562n, 2_002_000_000n, 1, 120_000n] as const;
const nowSeconds = () => 1_800_000_000;

type SimulateArgs = { functionName?: string; args?: Array<Record<string, unknown>> };
const calls: SimulateArgs[] = [];
const fakeViemClient = {
  // Exact viem 2.56.3 return shape.
  simulateContract: async (a: SimulateArgs) => {
    calls.push(a);
    return { result: QUOTER_RESULT, request: {} };
  },
};

function makeReader(simulate: (a: unknown) => unknown): ChainReader {
  return {
    chainId: 8453,
    // executor-config reads (owner/feeRecipient/feeBps/paused/balanceOf):
    readContract: (a: { functionName?: string }) => {
      switch (a.functionName) {
        case "owner":
          return Promise.resolve(OWNER);
        case "feeRecipient":
          return Promise.resolve(FEE_RECIPIENT);
        case "feeBps":
          return Promise.resolve(25);
        case "MAX_FEE_BPS":
          return Promise.resolve(300);
        case "paused":
          return Promise.resolve(false);
        case "balanceOf":
          return Promise.resolve(10n ** 12n); // huge USDC balance
        default:
          throw new Error(`unexpected readContract ${String(a.functionName)}`);
      }
    },
    simulateContract: (a: unknown) => simulate(a) as never,
    getBalance: () => Promise.resolve(10n ** 15n),
    getTransactionReceipt: () => Promise.resolve({} as never),
  } as unknown as ChainReader;
}

function makeGateway(simulate: (a: unknown) => unknown): McpTradeGateway {
  const deps = {
    registry: MPGR_EXECUTOR_DEPLOYMENTS,
    delegatedRegistry: { 84532: MPGR_EXECUTOR_DEPLOYMENTS[84532] },
    reader: () => makeReader(simulate),
    nowSeconds,
    quoteSecret: "gateway-reader-shape-test-secret",
    mainnetEnabled: true,
    mainnetFeeRecipient: FEE_RECIPIENT,
  } as never;
  return new McpTradeGateway(deps);
}

const quoteInput = {
  chainId: 8453,
  taker: "0xBF6c574b9543967f0D528ae49603b0A7574a280b",
  sellToken: BASE_MAINNET_USDC,
  buyToken: AAPLc,
  sellAmount: "1000000", // 1.00 USDC — the canary size
  slippageBps: 100,
};

describe("gateway quote over the canary harness reader shape (offline, mocked client)", () => {
  it("corrected single-wrap reader: real quote path returns numeric expected/minOut/fee", async () => {
    // Production createViemChainReader shape (executor-chain.ts:69).
    const gw = makeGateway((a) => fakeViemClient.simulateContract(a as SimulateArgs));
    const r = await gw.quote(quoteInput);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const q = r.data!;
    expect(q.chainId).toBe(8453);
    expect(BigInt(q.expectedBuyAmountRaw)).toBe(QUOTER_RESULT[0]); // tuple[0], a real bigint
    expect(BigInt(q.minBuyAmountRaw)).toBeGreaterThan(0n);
    expect(BigInt(q.minBuyAmountRaw)).toBeLessThanOrEqual(BigInt(q.expectedBuyAmountRaw));
    expect(Number(q.slippageBps)).toBe(100);
    expect(Number(q.feeBps)).toBe(25);
    expect(BigInt(q.feeAmountRaw)).toBe((1_000_000n * 25n) / 10_000n); // exact 25 bps = 2500
    expect(Number(q.quoteExpiresAt)).toBeGreaterThan(nowSeconds());
    // the quoter call went out as Slipstream quoteExactInputSingle on the pinned route
    const sim = calls.at(-1)!;
    expect(sim.functionName).toBe("quoteExactInputSingle");
    const params = sim.args![0] as Record<string, unknown>;
    expect(params.tokenIn).toBe(BASE_MAINNET_USDC);
    expect(params.tokenOut).toBe(AAPLc);
    expect(params.amountIn).toBe(997_500n); // gross 1_000_000 - fee 2_500
    expect(params.tickSpacing).toBe(10);
  });

  it("historical double-wrap reader: defense-in-depth returns structured QUOTE_FAILED (no crash, no broadcast)", async () => {
    // The pre-fix harness bug: wrapping viem's { result, request } AGAIN.
    const gw = makeGateway(async (a) => ({ result: await fakeViemClient.simulateContract(a as SimulateArgs) }));
    const r = await gw.quote(quoteInput);
    expect(r.ok).toBe(false);
    const f = (r as unknown as { failure?: { code: string; message: string } }).failure;
    expect(f?.code).toBe("QUOTE_FAILED");
    expect(f?.message).toContain("no usable output amount");
  });
});
