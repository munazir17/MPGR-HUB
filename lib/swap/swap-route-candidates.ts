// Swap-only deterministic search space. Never alters the shared Executor/Agent registry.
import { isAddress, keccak256, type Address, type Hex } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as d, BASE_MAINNET_SLIPSTREAM as slip, BASE_MAINNET_UNISWAP_V3 as uni, UNISWAP_V3_POOL_FEES, RouterKind, type ExecutorRoute } from "@/lib/executor/executor-config";
import type { TradeProposal } from "@/lib/trade/trade-types";
import { swapPoolAsset, swapRouteIssue } from "./swap-capability";

export const MAX_SWAP_ROUTE_CANDIDATES = 5;
export const swapRouteKey = (r: ExecutorRoute) => `${r.kind}:${r.router.toLowerCase()}:${r.poolFee ?? r.tickSpacing}`;

/** Only pre-approved token identities; pool existence/permission must still be proven by RPC.
 * V3's four contract-supported tiers and Slipstream's existing reviewed spacing 10.
 * No arbitrary address, V4, multihop, or imported-token authorization. */
export function swapRouteCandidates(from: string, to: string): ExecutorRoute[] {
  if (swapRouteIssue(from, to)) return [];
  const a = swapPoolAsset(from) as Address, b = swapPoolAsset(to) as Address;
  const routes: ExecutorRoute[] = [
    ...d.routes.filter(r => ((r.tokenA.toLowerCase() === a && r.tokenB.toLowerCase() === b) || (r.tokenB.toLowerCase() === a && r.tokenA.toLowerCase() === b)) &&
      ((r.kind === 2 && r.router === uni.swapRouter02 && UNISWAP_V3_POOL_FEES.includes(r.poolFee as typeof UNISWAP_V3_POOL_FEES[number])) || (r.kind === 1 && r.router === slip.swapRouter && r.tickSpacing === 10))),
    ...UNISWAP_V3_POOL_FEES.map(poolFee => ({ kind: RouterKind.UNISWAP_V3_ROUTER02, router: uni.swapRouter02, quoter: uni.quoterV2, poolFee, tokenA: a, tokenB: b })),
    { kind: RouterKind.AERODROME_SLIPSTREAM, router: slip.swapRouter, quoter: slip.quoterV2, tickSpacing: 10, tokenA: a, tokenB: b },
  ];
  return [...new Map(routes.map(r => [swapRouteKey(r), r])).values()].slice(0, MAX_SWAP_ROUTE_CANDIDATES);
}
export function isSwapRouteCandidate(from: string, to: string, route: ExecutorRoute): boolean {
  const a = swapPoolAsset(from), b = swapPoolAsset(to);
  return ((route.tokenA.toLowerCase() === a && route.tokenB.toLowerCase() === b) || (route.tokenB.toLowerCase() === a && route.tokenA.toLowerCase() === b)) &&
    swapRouteCandidates(from, to).some(r => swapRouteKey(r) === swapRouteKey(route) && r.quoter.toLowerCase() === route.quoter.toLowerCase() && r.poolFee === route.poolFee && r.tickSpacing === route.tickSpacing && route.moduleAddress === undefined && route.moduleCodeHash === undefined);
}
export interface SwapRouteOutcome {
  key: string;
  state: "quoted" | "rejected" | "unavailable";
  reason: string;
  output: string | null;
}
export interface SwapRoutingEvidence {
  version: 1;
  hops: 1;
  route: ExecutorRoute;
  pool: Address;
  blockNumber: string;
  blockHash: Hex;
  calldataHash: Hex;
  selection: "highest-quoted-output";
  comparisonComplete: boolean;
  outcomes: SwapRouteOutcome[];
  quoterGasUnits: string | null;
  executionSimulation: "not-run-wallet-preflight-required" | "eth-call-succeeded-no-settlement-proof";
}
export type SwapRoutedProposal = TradeProposal & { swapRouting?: SwapRoutingEvidence };
export const swapRoutingEvidence = (p: TradeProposal) => (p as SwapRoutedProposal).swapRouting;

/** Transaction/route binding, not a cryptographic certificate of liquidity or immutable fees.
 * Legacy proposals without search metadata retain the original registered-route checks. */
export function swapRoutingEvidenceValid(p: TradeProposal, e: SwapRoutingEvidence): boolean {
  return e.version === 1 && e.hops === 1 && e.selection === "highest-quoted-output" &&
    ["not-run-wallet-preflight-required", "eth-call-succeeded-no-settlement-proof"].includes(e.executionSimulation) && typeof e.comparisonComplete === "boolean" &&
    isSwapRouteCandidate(p.from.address, p.to.address, e.route) && isAddress(e.pool) && !/^0x0{40}$/i.test(e.pool) &&
    /^\d+$/.test(e.blockNumber) && /^0x[0-9a-f]{64}$/i.test(e.blockHash) &&
    !!p.transaction && e.calldataHash === keccak256(p.transaction.data) &&
    (e.quoterGasUnits === null || /^[1-9]\d*$/.test(e.quoterGasUnits)) &&
    Array.isArray(e.outcomes) && e.outcomes.length === swapRouteCandidates(p.from.address, p.to.address).length && e.outcomes.length <= MAX_SWAP_ROUTE_CANDIDATES &&
    new Set(e.outcomes.map(o => o.key)).size === e.outcomes.length &&
    e.outcomes.every(o => swapRouteCandidates(p.from.address, p.to.address).some(r => swapRouteKey(r) === o.key) &&
      ["quoted", "rejected", "unavailable"].includes(o.state) && typeof o.reason === "string" &&
      (o.state === "quoted" ? typeof o.output === "string" && /^[1-9]\d*$/.test(o.output) : o.output === null)) &&
    e.comparisonComplete === !e.outcomes.some(o => o.state === "unavailable") &&
    e.outcomes.every(o => o.state !== "quoted" || BigInt(o.output!) <= BigInt(p.toAmount)) &&
    e.outcomes.some(o => o.key === swapRouteKey(e.route) && o.state === "quoted" && o.output === p.toAmount);
}
