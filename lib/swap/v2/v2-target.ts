// lib/swap/v2/v2-target.ts
// The ONE client-safe discriminant for "is this proposal a V2 executor swap?".
//
// Client-safe on purpose (no `server-only`): swap-policy, swap-lifecycle,
// swap-allowance, swap-wallet, trade-agent-fee and trade-execution all run in
// the browser and each must pick the right deployed contract for THIS proposal.
// They previously recognised only the V1 swap-path executor and the legacy Agent
// executor, so a V2 transaction fell through to the legacy branch and was
// rejected before signing. Every one of them now asks this module first.
//
// Mirrors V1's `swapPathTarget` in lib/swap/swap-wallet.ts exactly: both
// executor families share provider "mpgr-executor", and the transaction TARGET
// picks the decoder. Each branch stays fail-closed on the other's calldata.
//
// The source gate is currently the sealed manifest, so a server-built V2
// proposal resolves here. `swapV2Executor()` returns null when that constant is
// reverted or a test injects null, and this module then returns null for every
// proposal. A V2 proposal can only exist if the server produced one under the
// same gate.
import type { TradeProposal } from "@/lib/trade/trade-types";
import { swapV2Executor, type SwapV2ExecutorDeployment } from "./deployment";

/** The sealed V2 deployment when `p.transaction` targets the V2 executor, else null. */
export function swapV2Target(p: Pick<TradeProposal, "transaction">): SwapV2ExecutorDeployment | null {
  const deployment = swapV2Executor();
  const to = p.transaction?.to;
  return deployment !== null && typeof to === "string" && to.toLowerCase() === deployment.executor.toLowerCase()
    ? deployment
    : null;
}

/** True only for a proposal whose transaction targets the activated V2 executor. */
export const isSwapV2Proposal = (p: Pick<TradeProposal, "transaction">): boolean => swapV2Target(p) !== null;
