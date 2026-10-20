// Wiring tests for the V2 execution surface inside the live swap journey.
//
// Two properties matter and they are tested separately:
//   A. DORMANT — with `V2_DEPLOYMENT` null, every V2 branch in the shared V1
//      dispatchers is inert, so V1 behaviour is bit-identical to before.
//   B. ACTIVATED — with the sealed manifest injected, one real V2 quote flows
//      through proposal adaptation, fee policy, quote freshness/expiry, evidence
//      binding, allowance-spender selection, the agent-fee target rule and
//      receipt settlement, for BOTH a SELL and a BUY.
//
// Offline: real calldata from the real encoder, fabricated receipts. No RPC.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex, Log } from "viem";
import { __setSwapV2ExecutorForTests, SWAP_V2_SEALED_MANIFEST } from "../deployment";
import { V2_FEE_RECIPIENT, type V2Quote } from "../discovery";
import { swapV2ProposalFromResponse, isExecutableSwapV2Response } from "../v2-proposal";
import { swapV2Target, isSwapV2Proposal } from "../v2-target";
import { inspectSwapV2Proposal } from "../v2-inspect";
import { swapV2RoutingEvidence, swapV2RoutingEvidenceValid } from "../v2-evidence";
import { swapQuotePolicyError, verifySwapSettlement } from "@/lib/swap/swap-policy";
import { swapQuoteExpiry, swapQuoteFresh } from "@/lib/swap/swap-lifecycle";
import { revalidateTradeProposal } from "@/lib/trade/trade-confirmation";
import { verifyAgentFeeInSwapTransaction } from "@/lib/trade/trade-agent-fee";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { POOL_AB, TAKER, TOKEN_A, TOKEN_B, UNI_V3_ROUTER, directQuote, v3Pool, v4Pool, HOOKS } from "./helpers";
import { activatedResponse, buyTokens, dormantResponse, sellTokens, swapExecutedLog, tokenRef, BLOCK } from "./activation-fixtures";

const EXECUTOR = SWAP_V2_SEALED_MANIFEST.executor;
const QUOTED_AT = Date.now();

/** The reverse direction: a BUY of TOKEN_A paying TOKEN_B, through the same pool. */
function reverseQuote(): V2Quote {
  const gross = 2_000_000n, fee = 5_000n, net = gross - fee;
  return {
    tokenIn: TOKEN_B, tokenOut: TOKEN_A, gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net, amountOut: 1_500n,
    legs: [{ pools: [v3Pool(TOKEN_A, TOKEN_B, POOL_AB)], tokens: [TOKEN_B, TOKEN_A], amountIn: net, amountOut: 1_500n }],
  };
}

const sellProposal = () => swapV2ProposalFromResponse(activatedResponse(), {
  from: sellTokens.from, to: sellTokens.to, taker: TAKER, slippageBps: 100, quotedAt: QUOTED_AT,
});
const buyProposal = () => swapV2ProposalFromResponse(activatedResponse({ quote: reverseQuote() }), {
  from: buyTokens.from, to: buyTokens.to, taker: TAKER, slippageBps: 100, quotedAt: QUOTED_AT,
});

/** A receipt whose SwapExecuted event matches the proposal's committed intent. */
function settledReceipt(p: TradeProposal, overrides: Partial<Parameters<typeof swapExecutedLog>[0]> = {}) {
  const evidence = swapV2RoutingEvidence(p)!;
  const log = swapExecutedLog({
    taker: p.taker, router: UNI_V3_ROUTER, intentId: evidence.intentId,
    tokenIn: (p.from.address.toLowerCase() === TOKEN_A ? TOKEN_A : TOKEN_B) as Address,
    tokenOut: (p.to.address.toLowerCase() === TOKEN_B ? TOKEN_B : TOKEN_A) as Address,
    grossAmountIn: BigInt(p.fromAmount), feeAmount: BigInt(p.agentFee!.amountAtomic),
    swapAmountIn: BigInt(p.fromAmount) - BigInt(p.agentFee!.amountAtomic),
    amountOut: BigInt(p.toAmount), feeRecipient: V2_FEE_RECIPIENT,
    feeBps: 25, routerKind: 2, flags: 0,
    ...overrides,
  });
  return {
    status: "success" as const,
    transactionHash: `0x${"aa".repeat(32)}` as Hex,
    blockNumber: BLOCK.number,
    from: p.taker,
    to: EXECUTOR,
    logs: [log] as unknown as readonly Log[],
  };
}

afterEach(() => __setSwapV2ExecutorForTests(null));

describe("V2 wiring — DORMANT gate leaves V1 untouched", () => {
  it("adapted no proposal from an executable-looking response", () => {
    // Even a fully-formed activated response yields nothing while the gate is null.
    expect(isExecutableSwapV2Response(activatedResponse())).toBe(true);
    expect(sellProposal()).toBeNull();
  });

  it("never treats a V2-targeted transaction as V2", () => {
    // This is the property that keeps V1 bit-identical: with the gate dormant the
    // discriminant is null even for calldata aimed at the V2 executor address, so
    // every dispatcher falls through to the untouched V1/legacy branches.
    const aimed = { transaction: { to: EXECUTOR, data: "0xdeadbeef" as Hex, value: "0" } };
    expect(swapV2Target(aimed)).toBeNull();
    expect(isSwapV2Proposal(aimed)).toBe(false);
    expect(inspectSwapV2Proposal({ ...(aimed as object), from: { address: TOKEN_A }, to: { address: TOKEN_B }, taker: TAKER } as TradeProposal)).toBeNull();
  });

  it("reports the dormant response as non-executable", () => {
    expect(isExecutableSwapV2Response(dormantResponse())).toBe(false);
    expect(dormantResponse()).toMatchObject({ preview: true, executable: false, transaction: null, executionSimulation: "not-run-unreleased" });
  });
});

describe("V2 wiring — ACTIVATED gate carries a quote through the whole journey", () => {
  beforeEach(() => __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST));

  it("adapts a SELL into a proposal that passes every downstream gate", () => {
    const p = sellProposal();
    expect(p).not.toBeNull();
    if (!p) return;
    // Shared engine compatibility.
    expect(revalidateTradeProposal(p, TAKER).state).toBe("VALIDATED");
    expect(p.provider).toBe("mpgr-executor");
    expect(p.kind).toBe("swap");
    expect(p.chainId).toBe(8453);
    // The fee invariant survives adaptation.
    expect(p.agentFee).toMatchObject({ status: "applied", bps: 25, amountAtomic: "2500", collection: "mpgr-executor" });
    expect(p.agentFee!.recipient!.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    // Policy, freshness and expiry all accept it (these are the dispatchers that
    // previously had no V2 branch and would have rejected or zeroed it).
    expect(swapQuotePolicyError(p)).toBeNull();
    expect(swapQuoteExpiry(p)).toBeGreaterThan(Date.now());
    expect(swapQuoteFresh(p)).toBe(true);
    // The agent-fee target rule now accepts the V2 executor.
    const feeInvariant = verifyAgentFeeInSwapTransaction(p);
    expect(feeInvariant.ok).toBe(true);
    // Narrow the discriminated union before reading `fee`.
    if (feeInvariant.ok) expect(feeInvariant.fee?.amount).toBe(2_500n);
    // BUY/SELL agreement: the approval spender is the contract being called.
    expect(p.transaction!.to.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(p.permit2Spender!.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(p.permit2).toBeNull();
    expect(p.needsPermit2Approval).toBe(true); // ERC-20 sell needs an approval
    // Evidence binds this exact calldata and block.
    const evidence = swapV2RoutingEvidence(p);
    expect(evidence).toBeDefined();
    expect(swapV2RoutingEvidenceValid(p, evidence!)).toBe(true);
    expect(evidence!.entry).toBe("swapExactInput");
    expect(evidence!.hops).toBe(1);
    expect(evidence!.blockNumber).toBe(BLOCK.number.toString());
    // Intent re-derives from the calldata.
    expect(isSwapV2Proposal(p)).toBe(true);
    const intent = inspectSwapV2Proposal(p);
    expect(intent?.ok).toBe(true);
    if (intent?.ok) {
      expect(intent.value.spender.toLowerCase()).toBe(EXECUTOR.toLowerCase());
      expect(intent.value.amountOutMinimum).toBe(BigInt(p.minToAmount));
      expect(intent.value.expectedFeeAmount).toBe(2_500n);
    }
  });

  it("adapts a BUY (reverse direction) with the same spender and fee rules", () => {
    const p = buyProposal();
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.from.address.toLowerCase()).toBe(TOKEN_B);
    expect(p.to.address.toLowerCase()).toBe(TOKEN_A);
    expect(revalidateTradeProposal(p, TAKER).state).toBe("VALIDATED");
    expect(swapQuotePolicyError(p)).toBeNull();
    expect(swapQuoteFresh(p)).toBe(true);
    expect(p.agentFee!.amountAtomic).toBe("5000"); // 25 bps on the BUY's own gross
    expect(p.permit2Spender!.toLowerCase()).toBe(p.transaction!.to.toLowerCase());
    expect(verifyAgentFeeInSwapTransaction(p).ok).toBe(true);
    const intent = inspectSwapV2Proposal(p);
    expect(intent?.ok).toBe(true);
    if (intent?.ok) {
      // Direction flipped, but the spender and the settlement target did not.
      expect(intent.value.tokenIn.toLowerCase()).toBe(TOKEN_B);
      expect(intent.value.tokenOut.toLowerCase()).toBe(TOKEN_A);
      expect(intent.value.spender.toLowerCase()).toBe(EXECUTOR.toLowerCase());
      expect(intent.value.recipient.toLowerCase()).toBe(TAKER.toLowerCase());
    }
  });

  it("needs no approval for a native ETH sell, and sends gross as value", () => {
    // A native sell normalizes to WETH on-chain and must route through a v4
    // PoolKey whose currency0 is the zero address — exactly the MPGR pool shape.
    // The UI represents a native sell with the NATIVE sentinel as the pay token
    // (decimals 18, kind "native"), while the quote's on-chain tokenIn is WETH.
    const eth = tokenRef(NATIVE_ETH_SENTINEL as Address, "ETH", 18, true);
    const WETH = "0x4200000000000000000000000000000000000006" as Address;
    const gross = 1_000_000n, fee = 2_500n, net = gross - fee;
    const nativeQuote: V2Quote = {
      tokenIn: WETH, tokenOut: TOKEN_B,
      gross, feeBps: 25, feeRecipient: V2_FEE_RECIPIENT, fee, net, amountOut: 1_000n,
      legs: [{
        pools: [v4Pool("0x0000000000000000000000000000000000000000", TOKEN_B, 0, 200, HOOKS)],
        tokens: [WETH, TOKEN_B], amountIn: net, amountOut: 1_000n,
      }],
    };
    const p = swapV2ProposalFromResponse(activatedResponse({ quote: nativeQuote, nativeIn: true }), {
      from: eth, to: sellTokens.to, taker: TAKER, slippageBps: 100, quotedAt: QUOTED_AT,
    });
    expect(p).not.toBeNull();
    if (!p) return;
    // Native ETH travels with the transaction: value == gross, no approval needed.
    expect(p.transaction!.value).toBe(p.fromAmount);
    expect(p.needsPermit2Approval).toBe(false);
    expect(p.permit2Spender).toBeNull();
    expect(swapQuotePolicyError(p)).toBeNull();
    expect(revalidateTradeProposal(p, TAKER).state).toBe("VALIDATED");
    const intent = inspectSwapV2Proposal(p);
    expect(intent?.ok).toBe(true);
    if (intent?.ok) {
      expect(intent.value.nativeIn).toBe(true);
      expect(intent.value.routerKind).toBe(7);
    }
    // And it settles: the native-in flag must be reflected in the event flags.
    const evidence = swapV2RoutingEvidence(p)!;
    const log = swapExecutedLog({
      taker: TAKER, router: "0x498581fF718922c3f8e6A244956aF099B2652b2b", intentId: evidence.intentId,
      tokenIn: WETH, tokenOut: TOKEN_B,
      grossAmountIn: gross, feeAmount: fee, swapAmountIn: net, amountOut: 1_000n,
      feeRecipient: V2_FEE_RECIPIENT, feeBps: 25, routerKind: 7, flags: 1,
    });
    const receipt = { status: "success" as const, transactionHash: `0x${"bb".repeat(32)}` as Hex, blockNumber: BLOCK.number, from: TAKER, to: EXECUTOR, logs: [log] as unknown as readonly Log[] };
    expect(verifySwapSettlement(p, receipt).verified).toBe(true);
  });

  it("verifies settlement end-to-end from a real encoded receipt", () => {
    const p = sellProposal();
    expect(p).not.toBeNull();
    if (!p) return;
    const proof = verifySwapSettlement(p, settledReceipt(p));
    expect(proof.verified).toBe(true);
    expect(proof.amountIn).toBe("1000000");
    expect(proof.amountOut).toBe("1000");
    expect(proof.feeAmount).toBe("2500");
    expect(proof.feeRecipient!.toLowerCase()).toBe(V2_FEE_RECIPIENT.toLowerCase());
    expect(proof.reason).toBeNull();
  });

  it("verifies settlement for the BUY direction too", () => {
    const p = buyProposal();
    expect(p).not.toBeNull();
    if (!p) return;
    const proof = verifySwapSettlement(p, settledReceipt(p));
    expect(proof.verified).toBe(true);
    expect(proof.amountIn).toBe("2000000");
    expect(proof.feeAmount).toBe("5000");
  });

  it("refuses to verify a settlement that broke the committed terms", () => {
    const p = sellProposal()!;
    // Output below the committed minimum: slippage protection bound this trade.
    expect(verifySwapSettlement(p, settledReceipt(p, { amountOut: BigInt(p.minToAmount) - 1n })).verified).toBe(false);
    // Fee skipped.
    expect(verifySwapSettlement(p, settledReceipt(p, { feeAmount: 0n, swapAmountIn: BigInt(p.fromAmount) })).verified).toBe(false);
    // Fee redirected away from the pinned treasury.
    expect(verifySwapSettlement(p, settledReceipt(p, { feeRecipient: TOKEN_A })).verified).toBe(false);
    // A different wallet's settlement.
    expect(verifySwapSettlement(p, settledReceipt(p, { taker: TOKEN_B })).verified).toBe(false);
    // Wrong fee bps.
    expect(verifySwapSettlement(p, settledReceipt(p, { feeBps: 30 })).verified).toBe(false);
    // No matching event at all.
    const empty = { ...settledReceipt(p), logs: [] as unknown as readonly Log[] };
    expect(verifySwapSettlement(p, empty).verified).toBe(false);
    // A reverted transaction is never "verified".
    const reverted = { ...settledReceipt(p), status: "reverted" as const };
    expect(verifySwapSettlement(p, reverted).verified).toBe(false);
  });
});

describe("V2 proposal adapter — fail-closed on tampering", () => {
  beforeEach(() => __setSwapV2ExecutorForTests(SWAP_V2_SEALED_MANIFEST));
  const mutate = (fn: (r: Record<string, unknown>) => void) => {
    const r = activatedResponse();
    fn(r);
    return swapV2ProposalFromResponse(r, { from: sellTokens.from, to: sellTokens.to, taker: TAKER, slippageBps: 100, quotedAt: QUOTED_AT });
  };
  const tx = (r: Record<string, unknown>) => r.transaction as Record<string, unknown>;
  const q = (r: Record<string, unknown>) => r.quote as Record<string, unknown>;

  it("rejects a fee that is not exactly 25 bps on gross", () => {
    expect(mutate((r) => { r.fee = "0"; })).toBeNull();
    expect(mutate((r) => { r.fee = "2400"; })).toBeNull();
    expect(mutate((r) => { r.feeBps = 26; })).toBeNull();
    expect(mutate((r) => { q(r).fee = "0"; })).toBeNull();
  });

  it("rejects a redirected fee recipient", () => {
    expect(mutate((r) => { r.feeRecipient = TOKEN_A; })).toBeNull();
    expect(mutate((r) => { q(r).feeRecipient = TOKEN_A; })).toBeNull();
  });

  it("rejects a minimum that is not exactly output less slippage", () => {
    expect(mutate((r) => { r.minToAmount = "991"; })).toBeNull();
    expect(mutate((r) => { r.minToAmount = "989"; })).toBeNull();
    expect(mutate((r) => { r.slippageBps = 200; })).toBeNull();
  });

  it("rejects a spender or executor that is not the sealed V2 address", () => {
    expect(mutate((r) => { r.spender = TOKEN_A; })).toBeNull();
    expect(mutate((r) => { r.executor = TOKEN_A; })).toBeNull();
    expect(mutate((r) => { tx(r).to = TOKEN_A; })).toBeNull();
  });

  it("rejects native-value mismatches", () => {
    expect(mutate((r) => { tx(r).value = "1"; })).toBeNull();
    expect(mutate((r) => { r.nativeIn = true; })).toBeNull();
  });

  it("rejects split legs that do not allocate exactly the net amount", () => {
    expect(mutate((r) => {
      const legs = q(r).legs as { amountIn: string }[];
      legs[0].amountIn = (BigInt(legs[0].amountIn) + 1n).toString();
    })).toBeNull();
  });

  it("rejects a response that claims to be executable but is still a preview", () => {
    expect(mutate((r) => { r.preview = true; })).toBeNull();
    expect(mutate((r) => { r.executionSimulation = "not-run-unreleased"; })).toBeNull();
    expect(mutate((r) => { r.transaction = null; })).toBeNull();
  });

  it("rejects malformed identity fields", () => {
    expect(mutate((r) => { r.intentId = "0x1234"; })).toBeNull();
    expect(mutate((r) => { r.blockHash = "0x1234"; })).toBeNull();
    expect(mutate((r) => { r.deadline = "0"; })).toBeNull();
    expect(mutate((r) => { r.chainId = 1; })).toBeNull();
    expect(mutate((r) => { r.entry = "swapExactOutput"; })).toBeNull();
  });

  it("rejects a deadline that has already passed", () => {
    expect(mutate((r) => { r.deadline = String(Math.floor(QUOTED_AT / 1000) - 10); })).toBeNull();
  });
});
