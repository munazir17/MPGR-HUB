// lib/swap/v2/v2-evidence.ts
// Binding between a V2 proposal and the exact transaction that was searched,
// simulated and inspected server-side. Mirrors lib/swap/swap-path-evidence.ts:
// an optional extra property on the proposal, read back through a cast helper,
// so the shared TradeProposal type is unchanged and V1 proposals are untouched.
//
// Evidence binds calldata/pools/block. It is NOT liquidity proof, NOT fee
// immutability proof and NOT a settlement proof — the receipt is verified
// separately after broadcast.
import { keccak256, type Address, type Hex } from "viem";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { swapV2Target } from "./v2-target";

/** Contract bounds: a single path is 1..3 hops; a split is 2..4 legs. */
export const SWAP_V2_MAX_HOPS = 3;
export const SWAP_V2_MAX_LEGS = 4;
export const SWAP_V2_MIN_LEGS = 2;

export type SwapV2Entry = "swapExactInput" | "swapExactInputSplit";

export interface SwapV2RoutingEvidence {
  version: 1;
  /** Deterministic id binding quote, taker, slippage, pinned block and pools. */
  intentId: Hex;
  entry: SwapV2Entry;
  /** Hops in the first leg; every leg is bounded by SWAP_V2_MAX_HOPS. */
  hops: number;
  legs: number;
  /** Every pool across every leg, in calldata order. */
  pools: readonly Address[];
  /** Hops per leg, so a split's shape is pinned too. */
  legHops: readonly number[];
  blockNumber: string;
  blockHash: Hex;
  calldataHash: Hex;
  executionSimulation: "eth-call-succeeded-no-settlement-proof";
  settlementNote: string;
}

export type SwapV2RoutedProposal = TradeProposal & { swapV2Routing?: SwapV2RoutingEvidence };

export const swapV2RoutingEvidence = (p: TradeProposal): SwapV2RoutingEvidence | undefined =>
  (p as SwapV2RoutedProposal).swapV2Routing;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH32 = /^0x[0-9a-f]{64}$/i;

/** Validates evidence against the proposal it is attached to. Fail-closed:
 * anything that does not bind this exact calldata, block and executor shape is
 * rejected, so stale or transplanted evidence cannot authorise a signature. */
export function swapV2RoutingEvidenceValid(p: TradeProposal, e: SwapV2RoutingEvidence): boolean {
  const deployment = swapV2Target(p);
  if (deployment === null) return false;
  if (e.version !== 1 || !HASH32.test(e.intentId)) return false;
  if (e.entry !== "swapExactInput" && e.entry !== "swapExactInputSplit") return false;
  if (!Array.isArray(e.legHops) || e.legHops.length !== e.legs) return false;
  if (!Number.isInteger(e.legs) || e.legs < 1 || e.legs > SWAP_V2_MAX_LEGS) return false;
  // A split must carry 2..4 legs; a single path must carry exactly one.
  if (e.entry === "swapExactInputSplit" && (e.legs < SWAP_V2_MIN_LEGS || e.legs > SWAP_V2_MAX_LEGS)) return false;
  if (e.entry === "swapExactInput" && e.legs !== 1) return false;
  if (!e.legHops.every((h) => Number.isInteger(h) && h >= 1 && h <= SWAP_V2_MAX_HOPS)) return false;
  // `hops` describes the first leg, matching what the calldata's path encodes.
  if (e.hops !== e.legHops[0]) return false;
  const totalHops = e.legHops.reduce((sum, h) => sum + h, 0);
  if (!Array.isArray(e.pools) || e.pools.length !== totalHops) return false;
  if (!e.pools.every((x) => ADDRESS.test(x) && BigInt(x) !== 0n)) return false;
  if (new Set(e.pools.map((x) => x.toLowerCase())).size !== e.pools.length) return false;
  if (!/^\d+$/.test(e.blockNumber) || !HASH32.test(e.blockHash)) return false;
  if (!p.transaction || e.calldataHash !== keccak256(p.transaction.data)) return false;
  if (e.executionSimulation !== "eth-call-succeeded-no-settlement-proof") return false;
  return typeof e.settlementNote === "string" && e.settlementNote.length > 0;
}
