// Swap-only policy. Never manufactures or modifies provider calldata.
import { type Address, type Hex } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment, findExecutorRoute, RouterKind } from "@/lib/executor/executor-config";
import { swapRoutingEvidence, swapRoutingEvidenceValid } from "./swap-route-candidates";
import { swapPathExecutor } from "./swap-executor-config";
import { inspectSwapExecutorTransaction, verifySwapPathSettlement } from "./swap-executor-intent";
import { inspectSwapV2Proposal } from "@/lib/swap/v2/v2-inspect";
import { swapV2Target } from "@/lib/swap/v2/v2-target";
import { swapV2RoutingEvidence, swapV2RoutingEvidenceValid } from "@/lib/swap/v2/v2-evidence";
import { verifyV2Receipt } from "@/lib/swap/v2/settlement";
import { swapPathRoutingEvidence, swapPathRoutingEvidenceValid } from "./swap-path-evidence";
import { inspectExecutorSwapTransaction, type ExecutorSwapIntent } from "@/lib/executor/executor-intent";
import { verifyExecutorReceipt, type ReceiptLike } from "@/lib/executor/executor-verify";
import { verifyAgentFeeInSwapTransaction } from "@/lib/trade/trade-agent-fee";
import { publicRouterPolicyError } from "@/lib/swap/route-desk";
import { isNativeEthSentinel, TRADE_MAX_SLIPPAGE_BPS, TRADE_MIN_SLIPPAGE_BPS } from "@/lib/trade/trade-config";
import type { TradeProposal } from "@/lib/trade/trade-types";

export const SWAP_FEE_BLOCK = "This route cannot safely collect the required 0.25% MPGR fee in the swap transaction. Swap is blocked; no separate fee transfer will be requested.";
export function parseSlippagePercent(raw: string): number | null {
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps >= TRADE_MIN_SLIPPAGE_BPS && bps <= TRADE_MAX_SLIPPAGE_BPS ? bps : null;
}
export const slippagePercent = (bps: number) => `${Math.floor(bps / 100)}${bps % 100 ? `.${String(bps % 100).padStart(2, "0").replace(/0$/, "")}` : ""}`;
export function safeMaximum(balance: bigint, native: boolean, gasEstimate: bigint | null): bigint | null {
  if (balance < 0n || (native && (gasEstimate === null || gasEstimate <= 0n))) return null;
  // Real Base total-fee estimate (L1 + operator + L2), doubled for volatility.
  const reserve = native ? gasEstimate! * 2n : 0n;
  return balance > reserve ? balance - reserve : 0n;
}
export function swapFeePolicyError(p: TradeProposal): string | null {
  try {
    if (p.provider === "public-router") return publicRouterPolicyError(p);
    if (p.provider !== "mpgr-executor" || p.agentFee?.status !== "applied" || p.agentFee.bps !== 25) return SWAP_FEE_BLOCK;
    const fee = verifyAgentFeeInSwapTransaction(p);
    if (!fee.ok || !fee.fee) return fee.ok ? SWAP_FEE_BLOCK : fee.reason;
    if (p.agentFee.recipient?.toLowerCase() !== deployment.feeRecipient.toLowerCase()) return SWAP_FEE_BLOCK;
    if (!p.transaction || p.permit2 || p.chainId !== 8453) return "Invalid Base Executor proposal.";
    // V2 branch. Recognised before V1/legacy because V2 calldata is undecodable
    // by both of their ABIs; null while the V2 gate is dormant, so the branches
    // below are untouched in production today.
    const v2 = inspectSwapV2Proposal(p);
    if (v2 !== null) {
      if (!v2.ok) return v2.reason;
      const y = v2.value;
      const v2Evidence = swapV2RoutingEvidence(p);
      if (v2Evidence !== undefined && !swapV2RoutingEvidenceValid(p, v2Evidence)) return "The V2 route search evidence does not match this transaction. Request a fresh quote.";
      if (y.grossAmountIn !== BigInt(p.fromAmount) || y.expectedFeeAmount !== fee.fee.amount ||
          y.amountOutMinimum !== BigInt(p.minToAmount) || y.amountOutMinimum <= 0n || y.amountOutMinimum > BigInt(p.toAmount) ||
          y.recipient.toLowerCase() !== p.taker.toLowerCase() || y.unwrapNativeOut !== isNativeEthSentinel(p.to.address) ||
          BigInt(p.transaction.value) !== (isNativeEthSentinel(p.from.address) ? BigInt(p.fromAmount) : 0n) ||
          // The fee lands at the pinned treasury and the approval spender is the
          // very contract receiving this calldata, so BUY and SELL agree.
          y.feeRecipient.toLowerCase() !== deployment.feeRecipient.toLowerCase() ||
          y.spender.toLowerCase() !== p.transaction.to.toLowerCase() ||
          (p.needsPermit2Approval && p.permit2Spender?.toLowerCase() !== p.transaction.to.toLowerCase()) ||
          y.hops < 1 || y.paths.length < 1 || y.paths.some(leg => leg.length < 1 || leg.some(h => BigInt(h.pool) === 0n))) {
        return "The executable V2 transaction does not match the reviewed tokens, amounts, recipient, minimum or route.";
      }
      return null;
    }
    const swapPathDeployment = swapPathExecutor();
    if (swapPathDeployment && p.transaction.to.toLowerCase() === swapPathDeployment.executor.toLowerCase()) {
      const pathIntent = inspectSwapExecutorTransaction(p.transaction, { deployment: swapPathDeployment, fromAddress: p.from.address, toAddress: p.to.address, taker: p.taker, nativeIn: isNativeEthSentinel(p.from.address), nativeOut: isNativeEthSentinel(p.to.address) });
      if (!pathIntent.ok) return pathIntent.reason;
      const y = pathIntent.value;
      const pathEvidence = swapPathRoutingEvidence(p);
      if (pathEvidence !== undefined && !swapPathRoutingEvidenceValid(p, pathEvidence)) return "The route search evidence does not match this transaction. Request a fresh quote.";
      if (y.grossAmountIn !== BigInt(p.fromAmount) || y.expectedFeeAmount !== fee.fee.amount ||
          y.amountOutMinimum !== BigInt(p.minToAmount) || y.amountOutMinimum <= 0n || y.amountOutMinimum > BigInt(p.toAmount) ||
          y.recipient.toLowerCase() !== p.taker.toLowerCase() || y.unwrapNativeOut !== isNativeEthSentinel(p.to.address) ||
          BigInt(p.transaction.value) !== (isNativeEthSentinel(p.from.address) ? BigInt(p.fromAmount) : 0n) ||
          y.hops.length < 1 || y.hops.some(h => BigInt(h.pool) === 0n)) return "The executable path transaction does not match the reviewed tokens, amounts, recipient, minimum or route.";
      return null;
    }
    const inspected = inspectExecutorSwapTransaction(p.transaction);
    if (!inspected.ok) return inspected.reason;
    const x = inspected.value;
    const from = isNativeEthSentinel(p.from.address) ? deployment.weth : p.from.address;
    const to = isNativeEthSentinel(p.to.address) ? deployment.weth : p.to.address;
    const evidence = swapRoutingEvidence(p);
    if (evidence !== undefined && !swapRoutingEvidenceValid(p, evidence)) return "The route search evidence does not match this transaction. Request a fresh quote.";
    const route = evidence?.route ?? findExecutorRoute(deployment, from, to);
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (!route || !eq(x.router, route.router) || !eq(x.tokenIn, from) || !eq(x.tokenOut, to) ||
        x.grossAmountIn !== BigInt(p.fromAmount) || x.expectedFeeAmount !== fee.fee.amount ||
        x.amountOutMinimum !== BigInt(p.minToAmount) || x.amountOutMinimum <= 0n ||
        x.amountOutMinimum > BigInt(p.toAmount) || !eq(x.recipient, p.taker) ||
        x.unwrapNativeOut !== isNativeEthSentinel(p.to.address) ||
        BigInt(p.transaction.value) !== (isNativeEthSentinel(p.from.address) ? BigInt(p.fromAmount) : 0n) ||
        (route.kind === RouterKind.UNISWAP_V3_ROUTER02 ? x.routerKind !== "UNISWAP_V3_ROUTER02" || x.poolFee !== route.poolFee : x.routerKind !== "AERODROME_SLIPSTREAM" || x.tickSpacing !== route.tickSpacing) ||
        (p.needsPermit2Approval && p.permit2Spender?.toLowerCase() !== deployment.executor.toLowerCase())) return "The executable transaction does not match the reviewed tokens, amounts, recipient, minimum or route.";
    return null;
  } catch { return "Malformed executable swap. Request a fresh quote."; }
}
// Admission/signing check uses the QUOTED output. Settlement verification below
// instead uses the committed minimum and actual event output; never reconstruct
// a historical expected quote from an amount that happened to settle.
export function swapQuotePolicyError(p: TradeProposal): string | null {
  const invalid = swapFeePolicyError(p); if (invalid) return invalid;
  try {
    if (!Number.isInteger(p.slippageBps) || p.slippageBps < TRADE_MIN_SLIPPAGE_BPS || p.slippageBps > TRADE_MAX_SLIPPAGE_BPS ||
        BigInt(p.toAmount) <= 0n || BigInt(p.minToAmount) !== BigInt(p.toAmount) * BigInt(10000 - p.slippageBps) / 10000n) {
      return "The minimum receive does not match the quoted output and selected slippage. Request a fresh quote.";
    }
    return null;
  } catch { return "Invalid quoted amounts. Request a fresh quote."; }
}
export interface SwapSettlement { verified: boolean; amountIn: string | null; amountOut: string | null; feeAmount: string | null; feeRecipient: Address | null; reason: string | null }
export function verifySwapSettlement(p: TradeProposal, receipt: ReceiptLike): SwapSettlement {
  const unknown = (reason: string): SwapSettlement => ({ verified: false, amountIn: null, amountOut: null, feeAmount: null, feeRecipient: null, reason });
  try {
    const invalid = swapFeePolicyError(p);
    if (invalid || !p.transaction) return unknown(invalid ?? "Missing transaction.");
    if (p.provider === "public-router") {
      if (receipt.status !== "success") return unknown("The routed swap reverted on Base.");
      if (receipt.to?.toLowerCase() !== p.transaction.to.toLowerCase()) return unknown("The mined transaction does not match the reviewed router.");
      return { verified: true, amountIn: p.fromAmount, amountOut: null, feeAmount: null, feeRecipient: null, reason: null };
    }
    // V2 settlement: re-derive the intent from the reviewed calldata, then verify
    // the receipt's own events against it. Null while the V2 gate is dormant.
    const v2Intent = inspectSwapV2Proposal(p);
    if (v2Intent !== null) {
      const v2Deployment = swapV2Target(p)!;
      if (!v2Intent.ok) return unknown(v2Intent.reason);
      const proof = verifyV2Receipt(v2Intent.value, {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        logs: receipt.logs.map(l => ({ address: l.address, topics: l.topics as readonly Hex[], data: l.data })),
      }, v2Deployment);
      return proof.verified
        ? { verified: true, amountIn: proof.amountIn, amountOut: proof.amountOut, feeAmount: proof.feeAmount, feeRecipient: proof.feeRecipient, reason: null }
        : unknown(proof.reason ?? "Swap settlement unverified.");
    }
    const swapPathDeployment = swapPathExecutor();
    if (swapPathDeployment && p.transaction.to.toLowerCase() === swapPathDeployment.executor.toLowerCase()) {
      const proof = verifySwapPathSettlement(p, swapPathDeployment, receipt);
      return proof.verified ? { verified: true, amountIn: proof.amountIn, amountOut: proof.amountOut, feeAmount: proof.feeAmount, feeRecipient: proof.feeRecipient, reason: null } : unknown(proof.reason ?? "Swap settlement unverified.");
    }
    const inspected = inspectExecutorSwapTransaction(p.transaction);
    if (!inspected.ok) return unknown(inspected.reason);
    const x = inspected.value;
    const route = swapRoutingEvidence(p)?.route ?? findExecutorRoute(deployment, x.tokenIn, x.tokenOut)!;
    const intent: ExecutorSwapIntent = {
      version: 1, chainId: 8453, executor: deployment.executor, router: x.router, routerKind: route.kind,
      taker: p.taker, recipient: p.taker, sellToken: { address: x.tokenIn, symbol: p.from.symbol, decimals: p.from.decimals },
      buyToken: { address: x.tokenOut, symbol: p.to.symbol, decimals: p.to.decimals }, sellNative: isNativeEthSentinel(p.from.address), buyNative: x.unwrapNativeOut,
      sellAmount: p.fromAmount, feeBps: 25, feeAmount: p.agentFee!.amountAtomic, feeToken: isNativeEthSentinel(p.from.address) ? "ETH" : x.tokenIn,
      feeRecipient: p.agentFee!.recipient!, swapAmount: x.swapAmountIn.toString(), expectedBuyAmount: p.toAmount,
      minBuyAmount: p.minToAmount, slippageBps: p.slippageBps, deadline: Number(x.deadline), intentId: x.intentId,
      authorization: "APPROVAL", spender: deployment.executor,
    };
    const proof = verifyExecutorReceipt(receipt, intent);
    if (!proof.verified || !proof.event) return unknown("Receipt did not verify the exact Executor swap and fee collection. Do not resubmit; inspect the transaction.");
    return { verified: true, amountIn: proof.event.grossAmountIn, amountOut: proof.event.amountOut, feeAmount: proof.event.feeAmount, feeRecipient: proof.event.feeRecipient, reason: null };
  } catch { return unknown("Execution evidence is unavailable. No output or fee collection has been verified."); }
}
