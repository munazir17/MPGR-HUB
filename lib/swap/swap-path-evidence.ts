// lib/swap/swap-path-evidence.ts
// Binding between a path proposal and the exact typed transaction searched.
import { keccak256, type Address, type Hex } from "viem";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { SWAP_MAX_PATH_HOPS, swapPathExecutor } from "./swap-executor-config";
import { MAX_SWAP_PATH_CANDIDATES } from "./swap-path-candidates";

export interface SwapPathOutcome { key: string; state: "quoted" | "rejected" | "unavailable"; reason: string; output: string | null }
export interface SwapPathRoutingEvidence {
  version: 2;
  key: string;
  hops: number;
  pools: readonly Address[];
  blockNumber: string;
  blockHash: Hex;
  calldataHash: Hex;
  outcomes: readonly SwapPathOutcome[];
  executionSimulation: "not-run-wallet-preflight-required" | "eth-call-succeeded-no-settlement-proof";
}
export type SwapPathRoutedProposal = TradeProposal & { swapPathRouting?: SwapPathRoutingEvidence };
export const swapPathRoutingEvidence = (p: TradeProposal): SwapPathRoutingEvidence | undefined => (p as SwapPathRoutedProposal).swapPathRouting;

/** Evidence binds calldata/pools/block; it is not liquidity or fee immutability proof. */
export function swapPathRoutingEvidenceValid(p: TradeProposal, e: SwapPathRoutingEvidence): boolean {
  const deployment = swapPathExecutor();
  return deployment !== null && e.version === 2 && typeof e.key === "string" && e.key.length > 0 &&
    Number.isInteger(e.hops) && e.hops >= 1 && e.hops <= SWAP_MAX_PATH_HOPS &&
    Array.isArray(e.pools) && e.pools.length === e.hops && e.pools.every(x => /^0x[0-9a-fA-F]{40}$/.test(x) && BigInt(x) !== 0n) &&
    /^\d+$/.test(e.blockNumber) && /^0x[0-9a-f]{64}$/i.test(e.blockHash) &&
    !!p.transaction && e.calldataHash === keccak256(p.transaction.data) &&
    // One outcome per evaluated candidate. (The previous fixed cap of 8
    // silently rejected every winner whose search evaluated more
    // candidates — e.g. any token<->token pair where neither side was
    // WETH/USDC, which evaluates every direct and bridged candidate.)
    Array.isArray(e.outcomes) && e.outcomes.length > 0 && e.outcomes.length <= MAX_SWAP_PATH_CANDIDATES &&
    new Set(e.outcomes.map(o => o.key)).size === e.outcomes.length &&
    e.outcomes.every(o => typeof o.key === "string" && ["quoted", "rejected", "unavailable"].includes(o.state) && typeof o.reason === "string" &&
      (o.state === "quoted" ? typeof o.output === "string" && /^[1-9]\d*$/.test(o.output) : o.output === null)) &&
    ["not-run-wallet-preflight-required", "eth-call-succeeded-no-settlement-proof"].includes(e.executionSimulation);
}
