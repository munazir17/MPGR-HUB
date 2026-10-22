// lib/swap/v2/v2-inspect.ts
// One shared way to inspect a proposal's V2 calldata, so every dispatcher
// (policy, lifecycle, allowance, wallet preflight, agent-fee, execution engine)
// branches identically instead of re-deriving the context slightly differently.
//
// Client-safe: `intent.ts` is pure, and V1 already inspects calldata in the
// browser via `swap-executor-intent.ts`.
//
// Returns `null` when the proposal is not a V2 transaction at all, so callers can
// test once and fall through to the untouched V1/legacy branches. While
// `V2_DEPLOYMENT` is null this always returns null, so V1 behaviour is unchanged.
import { isNativeEthSentinel } from "@/lib/trade/trade-config";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { V2_FEE_BPS, V2_FEE_RECIPIENT } from "./discovery";
import { inspectV2SwapTransaction, type V2IntentResult, type V2TransactionLike } from "./intent";
import { swapV2Target } from "./v2-target";

/** Inspects an explicit transaction (the one about to be signed) with the context
 * derived from `p`. Returns null when `p` is not a V2 proposal at all. */
export function inspectSwapV2Transaction(p: TradeProposal, transaction: V2TransactionLike): V2IntentResult | null {
  const deployment = swapV2Target(p);
  if (deployment === null) return null;
  return inspectV2SwapTransaction(transaction, {
    deployment,
    fromAddress: p.from.address,
    toAddress: p.to.address,
    taker: p.taker,
    nativeIn: isNativeEthSentinel(p.from.address),
    nativeOut: isNativeEthSentinel(p.to.address),
    feeBps: V2_FEE_BPS,
    feeRecipient: V2_FEE_RECIPIENT,
  });
}

/** Inspects a proposal's V2 calldata against the required 25 bps policy fee and
 * the pinned treasury recipient. Live fee drift is caught separately by the
 * wallet preflight, which reads `feeBps`/`feeRecipient` from the executor. */
export function inspectSwapV2Proposal(p: TradeProposal): V2IntentResult | null {
  if (!p.transaction) return null;
  return inspectSwapV2Transaction(p, p.transaction);
}
