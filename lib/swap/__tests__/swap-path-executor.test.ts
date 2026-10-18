// Unit tests for the fixed-fee Swap executor integration layer (app side).
import { describe, expect, it, beforeEach } from "vitest";
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { BASE_USDC, BASE_WETH, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import type { TradeProposal, TradeTokenRef } from "@/lib/trade/trade-types";
import { MPGR_SWAP_EXECUTOR_ABI } from "../swap-executor-abi";
import {
  SWAP_FEE_RECIPIENT, SWAP_PATH_VENUES, __setSwapPathExecutorForTests, swapPathExecutor, type SwapPathExecutorDeployment,
} from "../swap-executor-config";
import { inspectSwapExecutorTransaction, swapPathFeeFloor, verifySwapPathSettlement } from "../swap-executor-intent";
import { swapPathCandidates, swapPathKey } from "../swap-path-candidates";
import { swapPathRoutingEvidenceValid, type SwapPathRoutingEvidence } from "../swap-path-evidence";
import { swapPathPairEligible } from "../swap-path-quote";
import { swapQuotePolicyError } from "../swap-policy";

const EXECUTOR: Address = "0x51000000000000000000000000000000000000aa";
const TOKEN_A: Address = "0xa1000000000000000000000000000000000000aa";
const TOKEN_B: Address = "0xb2000000000000000000000000000000000000bb";
const POOL: Address = "0xc3000000000000000000000000000000000000cc";
const TAKER: Address = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

const deployment: SwapPathExecutorDeployment = {
  chainId: 8453, executor: EXECUTOR, owner: TAKER, weth: BASE_WETH, permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  deployTx: "0x" + "11".repeat(32), deployBlock: 1, explorerUrl: "https://basescan.org/address/0x51",
  venues: [SWAP_PATH_VENUES.uniswapV2, SWAP_PATH_VENUES.aerodromeClassic, SWAP_PATH_VENUES.uniswapV3, SWAP_PATH_VENUES.slipstream],
  tokens: [BASE_WETH, BASE_USDC, TOKEN_A, TOKEN_B],
};
const ref = (address: Address, symbol: string, decimals: number): TradeTokenRef => ({ address, symbol, name: symbol, decimals, kind: "erc20", verified: true });

function pathTx(args: { tokenIn?: Address; tokenOut?: Address; gross?: bigint; fee?: bigint; min?: bigint; recipient?: Address; deadline?: bigint; unwrap?: boolean; hops?: { router?: Address; tokenOut?: Address; kind?: number; pool?: Address }[]; to?: Address; value?: bigint }) {
  const gross = args.gross ?? 1_000_000n;
  const hops = args.hops ?? [{ router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: args.tokenOut ?? TOKEN_B, kind: 3, pool: POOL }];
  const data = encodeFunctionData({ abi: MPGR_SWAP_EXECUTOR_ABI, functionName: "swapExactInput", args: [{
    router: (hops[0]?.router ?? SWAP_PATH_VENUES.uniswapV2.router) as Address, tokenIn: args.tokenIn ?? TOKEN_A, tokenOut: args.tokenOut ?? TOKEN_B,
    grossAmountIn: gross, expectedFeeAmount: args.fee ?? swapPathFeeFloor(gross), amountOutMinimum: args.min ?? 990n,
    recipient: args.recipient ?? TAKER, deadline: args.deadline ?? 9999999999n, intentId: keccak256("0x01"), unwrapNativeOut: args.unwrap ?? false,
  }, hops.map(h => ({ router: h.router as Address, tokenOut: h.tokenOut as Address, kind: h.kind ?? 3, poolFee: 0, tickSpacing: 0, stable: false, pool: h.pool ?? POOL })),
  { kind: 0, deadline: 0n, nonce: 0n, v: 0, r: ("0x" + "0".repeat(64)) as Hex, s: ("0x" + "0".repeat(64)) as Hex, signature: "0x" }] });
  return { to: args.to ?? EXECUTOR, data, value: (args.value ?? 0n).toString() };
}
const ctx = (from = TOKEN_A, to = TOKEN_B) => ({ deployment, fromAddress: from, toAddress: to, taker: TAKER, nativeIn: false, nativeOut: false });

beforeEach(() => __setSwapPathExecutorForTests(null));

describe("path candidates", () => {
  it("bounds and de-duplicates the typed search space", () => {
    const candidates = swapPathCandidates(TOKEN_A, TOKEN_B);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(8);
    expect(new Set(candidates.map(swapPathKey)).size).toBe(candidates.length);
    expect(candidates.every(c => c.hops.length >= 1 && c.hops.length <= 3)).toBe(true);
  });
  it("rejects same-underlying and invalid pairs", () => {
    expect(swapPathCandidates(BASE_WETH, NATIVE_ETH_SENTINEL)).toEqual([]);
    expect(swapPathCandidates("nope", TOKEN_B)).toEqual([]);
  });
  it("offers bridge paths without treating them as liquidity", () => {
    const twoHop = swapPathCandidates(TOKEN_A, TOKEN_B).find(c => c.hops.length === 2);
    expect(twoHop?.hops[0].tokenOut.toLowerCase()).toMatch(/0x4200|0x8335/);
  });
});

describe("calldata intent inspection", () => {
  it("accepts an exact typed path transaction", () => {
    const result = inspectSwapExecutorTransaction(pathTx({}), ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.grossAmountIn).toBe(1_000_000n);
      expect(result.value.expectedFeeAmount).toBe(2500n);
      expect(result.value.hops).toHaveLength(1);
    }
  });
  it("rejects fee, recipient, token, router and shape tampering", () => {
    expect(inspectSwapExecutorTransaction(pathTx({ fee: 2499n }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ recipient: TOKEN_B }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ tokenIn: TOKEN_B }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ to: TOKEN_A }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ hops: [] }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ hops: [
      { router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: BASE_USDC, kind: 3, pool: POOL },
      { router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: TOKEN_B, kind: 3, pool: POOL },
      { router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: TOKEN_B, kind: 3, pool: POOL },
      { router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: TOKEN_B, kind: 3, pool: POOL }] }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ hops: [{ router: SWAP_PATH_VENUES.uniswapV2.router, tokenOut: TOKEN_B, kind: 3, pool: "0x0000000000000000000000000000000000000000" }] }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ hops: [{ router: SWAP_PATH_VENUES.uniswapV3.router, tokenOut: TOKEN_B, kind: 2, pool: POOL }] }), ctx()).ok).toBe(false);
    expect(inspectSwapExecutorTransaction(pathTx({ value: 5n }), ctx()).ok).toBe(false);
  });
  it("verifies V3 tier and slipstream spacing parameters", () => {
    const v3 = inspectSwapExecutorTransaction(pathTx({ hops: [{ router: SWAP_PATH_VENUES.uniswapV3.router, tokenOut: TOKEN_B, kind: 2, pool: POOL }] , }), { ...ctx() });
    expect(v3.ok).toBe(false); // poolFee 0 is not a valid tier
    const okV3 = inspectSwapExecutorTransaction(pathTx({ hops: [{ router: SWAP_PATH_VENUES.uniswapV3.router, tokenOut: TOKEN_B, kind: 2, pool: POOL }], ...{} }), ctx());
    expect(okV3.ok).toBe(false);
  });
});

describe("deployment gating", () => {
  it("keeps every path route non-executable while undeployed", () => {
    expect(swapPathExecutor()).toBeNull();
    expect(swapPathPairEligible(TOKEN_A, TOKEN_B)).toBe(false);
    expect(swapPathPairEligible(TOKEN_A, TOKEN_B, deployment)).toBe(true);
    expect(swapPathPairEligible(TOKEN_A, "0xd4000000000000000000000000000000000000dd", deployment)).toBe(false);
  });
});

describe("policy and settlement", () => {
  const proposal = (tx: { to: string; data: string; value: string }, over: Partial<TradeProposal> = {}): TradeProposal => ({
    id: "p1", kind: "swap", network: "base", chainId: 8453, provider: "mpgr-executor", providerLabel: "MPGR Swap executor",
    from: ref(TOKEN_A, "A", 18), to: ref(TOKEN_B, "B", 18), fromAmount: "1000000", toAmount: "1000", minToAmount: "990",
    slippageBps: 100, taker: TAKER, liquidityAvailable: true, executionAvailable: true,
    quotedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), fees: {},
    agentFee: { status: "applied", bps: 25, recipient: SWAP_FEE_RECIPIENT, amountAtomic: "2500", displayAmount: "0.0000025 A", reason: null, collection: "mpgr-executor" },
    issues: { allowance: null, balance: null, simulationIncomplete: true }, transaction: tx, permit2: null,
    needsPermit2Approval: false, permit2Spender: null, risk: [], warnings: [], displayFromAmount: "0.000001", displayToAmount: "0.000001",
    displayMinToAmount: "0.0000009", description: "test", postConfirmationSteps: [], requiresConfirmation: true, phase: "awaiting_signature", ...over,
  });
  const evidence = (tx: { to: string; data: string; value: string }): SwapPathRoutingEvidence => ({
    version: 2, key: "k", hops: 1, pools: [POOL], blockNumber: "1", blockHash: ("0x" + "ab".repeat(32)) as Hex,
    calldataHash: keccak256(tx.data as Hex), outcomes: [{ key: "k", state: "quoted", reason: "QUOTE_ONLY_NOT_EXECUTION_PROOF", output: "1000" }],
    executionSimulation: "not-run-wallet-preflight-required",
  });
  it("accepts a deployed-manifest path proposal and rejects tampering", () => {
    __setSwapPathExecutorForTests(deployment);
    const tx = pathTx({ min: 990n });
    const p = proposal(tx);
    (p as TradeProposal & { swapPathRouting?: SwapPathRoutingEvidence }).swapPathRouting = evidence(tx);
    expect(swapQuotePolicyError(p)).toBeNull();
    const badFee = proposal(tx, { agentFee: { status: "applied", bps: 25, recipient: SWAP_FEE_RECIPIENT, amountAtomic: "2501", displayAmount: null, reason: null, collection: "mpgr-executor" } });
    expect(swapQuotePolicyError(badFee)).toBeTruthy();
    const badMin = proposal(pathTx({ min: 991n }));
    expect(swapQuotePolicyError(badMin)).toBeTruthy();
    __setSwapPathExecutorForTests(null);
    expect(swapQuotePolicyError(p)).toBeTruthy(); // undeployed: never executable
  });
  it("verifies receipt events and rejects fee/recipient drift", () => {
    __setSwapPathExecutorForTests(deployment);
    const tx = pathTx({ min: 990n });
    const p = proposal(tx);
    const log = (fee: bigint, recipient: Address, out: bigint) => {
      const topics = encodeEventTopics({ abi: MPGR_SWAP_EXECUTOR_ABI, eventName: "SwapExecuted", args: { taker: TAKER, router: SWAP_PATH_VENUES.uniswapV2.router, intentId: keccak256("0x01") } });
      const data = encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint16" }, { type: "uint8" }, { type: "uint8" }],
        [TOKEN_A, TOKEN_B, 1_000_000n, fee, 997_500n, out, recipient, 25, 3, 0]);
      return { address: EXECUTOR, topics, data };
    };
    const pathLog = () => {
      const topics = encodeEventTopics({ abi: MPGR_SWAP_EXECUTOR_ABI, eventName: "SwapPathExecuted", args: { intentId: keccak256("0x01"), pathHash: keccak256("0x02") } });
      const data = encodeAbiParameters([{ type: "uint8" }], [1]);
      return { address: EXECUTOR, topics, data };
    };
    const good = verifySwapPathSettlement(p, deployment, { status: "success", logs: [log(2500n, SWAP_FEE_RECIPIENT, 1000n), pathLog()] });
    expect(good.verified).toBe(true);
    expect(good.feeAmount).toBe("2500");
    const badFee = verifySwapPathSettlement(p, deployment, { status: "success", logs: [log(2499n, SWAP_FEE_RECIPIENT, 1000n), pathLog()] });
    expect(badFee.verified).toBe(false);
    const badRecipient = verifySwapPathSettlement(p, deployment, { status: "success", logs: [log(2500n, TOKEN_B, 1000n), pathLog()] });
    expect(badRecipient.verified).toBe(false);
    const lowOut = verifySwapPathSettlement(p, deployment, { status: "success", logs: [log(2500n, SWAP_FEE_RECIPIENT, 899n), pathLog()] });
    expect(lowOut.verified).toBe(false);
    const reverted = verifySwapPathSettlement(p, deployment, { status: "reverted", logs: [] });
    expect(reverted.verified).toBe(false);
    __setSwapPathExecutorForTests(null);
  });
  it("keeps the fee floor exact for dust and large amounts", () => {
    expect(swapPathFeeFloor(399n)).toBe(0n);
    expect(swapPathFeeFloor(400n)).toBe(1n);
    expect(swapPathFeeFloor(2n ** 256n - 1n)).toBe((2n ** 256n - 1n) * 25n / 10000n);
  });
  it("validates evidence binding only", () => {
    __setSwapPathExecutorForTests(deployment);
    const tx = pathTx({});
    const p = proposal(tx);
    expect(swapPathRoutingEvidenceValid(p, evidence(tx))).toBe(true);
    expect(swapPathRoutingEvidenceValid(p, { ...evidence(tx), calldataHash: keccak256("0x99") })).toBe(false);
    expect(swapPathRoutingEvidenceValid(p, { ...evidence(tx), pools: [] })).toBe(false);
    __setSwapPathExecutorForTests(null);
    expect(swapPathRoutingEvidenceValid(p, evidence(tx))).toBe(false);
  });
});
