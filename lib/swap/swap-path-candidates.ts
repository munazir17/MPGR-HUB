// lib/swap/swap-path-candidates.ts
// Deterministic, bounded typed path search space for the fixed-fee Swap
// executor. Pure address math: no RPC, no liquidity claim, no execution right.
import { isAddress, type Address } from "viem";
import { BASE_USDC, BASE_WETH, isNativeEthSentinel } from "@/lib/trade/trade-config";
import {
  SWAP_MAX_PATH_HOPS, SWAP_PATH_VENUES, swapV3PoolFees, type SwapVenueKind,
} from "./swap-executor-config";

export interface SwapPathHop {
  kind: SwapVenueKind;
  router: Address;
  factory: Address;
  /** Pool key: V3 fee tier, Slipstream tickSpacing, Classic stable flag. */
  poolFee?: number;
  tickSpacing?: number;
  stable?: boolean;
  tokenOut: Address;
}
export interface SwapPathCandidate { hops: readonly SwapPathHop[] }
export const MAX_SWAP_PATH_CANDIDATES = 14;
export const SWAP_PATH_BRIDGES: readonly Address[] = [BASE_WETH, BASE_USDC];

export const swapPathAsset = (address: string): Address =>
  (isNativeEthSentinel(address) ? BASE_WETH : address) as Address;
export const swapPathHopKey = (h: SwapPathHop) =>
  `${h.kind}:${h.router.toLowerCase()}:${h.poolFee ?? h.tickSpacing ?? (h.stable ? "stable" : "volatile")}`;
export const swapPathKey = (c: SwapPathCandidate) => c.hops.map(swapPathHopKey).join(">");

// KNOWN LIMITATION — Pancake V3 is registered on-chain (see the sealed
// manifest) but deliberately NOT a candidate venue: the deployed
// executor's Pancake adapter encodes the no-deadline (Router02-shaped)
// exactInputSingle, while the live PancakeSwap V3 SwapRouter on Base
// (0x1b81D678…) requires the deadline-bearing struct — a different
// function selector, so every Pancake call reverts (verified against the
// router's verified source and by fork test, 2026-10-19). Do not add
// Pancake candidates until governance re-registers the PANCAKE_V3 kind to
// a no-deadline-compatible router and the fork suites are flipped back to
// success assertions.
function directHops(to: Address): SwapPathHop[] {
  return [
    { kind: SWAP_PATH_VENUES.uniswapV2.kind, router: SWAP_PATH_VENUES.uniswapV2.router, factory: SWAP_PATH_VENUES.uniswapV2.factory, tokenOut: to },
    { kind: SWAP_PATH_VENUES.aerodromeClassic.kind, router: SWAP_PATH_VENUES.aerodromeClassic.router, factory: SWAP_PATH_VENUES.aerodromeClassic.factory, stable: false, tokenOut: to },
    { kind: SWAP_PATH_VENUES.uniswapV3.kind, router: SWAP_PATH_VENUES.uniswapV3.router, factory: SWAP_PATH_VENUES.uniswapV3.factory, poolFee: 3000, tokenOut: to },
    { kind: SWAP_PATH_VENUES.slipstream.kind, router: SWAP_PATH_VENUES.slipstream.router, factory: SWAP_PATH_VENUES.slipstream.factory, tickSpacing: 10, tokenOut: to },
  ];
}

/** Direct typed venues plus one-bridge two-hop paths (WETH/USDC). Bounded and
 * de-duplicated; the executor itself still enforces ≤3 hops and allowlists. */
export function swapPathCandidates(from: string, to: string): SwapPathCandidate[] {
  if (!isAddress(from, { strict: false }) || !isAddress(to, { strict: false })) return [];
  const a = swapPathAsset(from).toLowerCase(), b = swapPathAsset(to).toLowerCase();
  if (a === b) return [];
  const A = swapPathAsset(from), B = swapPathAsset(to);
  const out: SwapPathCandidate[] = directHops(B).map(h => ({ hops: [strip(h)] }));
  for (const bridge of SWAP_PATH_BRIDGES.map(x => x.toLowerCase())) {
    if (bridge === a || bridge === b) continue;
    const BR = swapPathAsset(bridge);
    // Prefer cheap, liquid first legs: V2, Classic volatile, V3 0.30%, Slip 10.
    const leg = (tokenOut: Address): SwapPathHop[] => [
      { kind: SWAP_PATH_VENUES.uniswapV2.kind, router: SWAP_PATH_VENUES.uniswapV2.router, factory: SWAP_PATH_VENUES.uniswapV2.factory, tokenOut },
      { kind: SWAP_PATH_VENUES.uniswapV3.kind, router: SWAP_PATH_VENUES.uniswapV3.router, factory: SWAP_PATH_VENUES.uniswapV3.factory, poolFee: 3000, tokenOut },
      { kind: SWAP_PATH_VENUES.slipstream.kind, router: SWAP_PATH_VENUES.slipstream.router, factory: SWAP_PATH_VENUES.slipstream.factory, tickSpacing: 10, tokenOut },
    ];
    const combos: [number, number][] = [[0, 0], [1, 1], [2, 2]];
    const firstLegs = leg(BR), secondLegs = leg(B);
    for (const [i, j] of combos) out.push({ hops: [strip(firstLegs[i]), strip(secondLegs[j])] });
  }
  const unique = [...new Map(out.map(c => [swapPathKey(c), c])).values()];
  return unique.filter(c => c.hops.length <= SWAP_MAX_PATH_HOPS).slice(0, MAX_SWAP_PATH_CANDIDATES);
}
function strip(h: SwapPathHop): SwapPathHop {
  const { kind, router, factory, poolFee, tickSpacing, stable, tokenOut } = h;
  return poolFee === undefined && tickSpacing === undefined && stable === undefined
    ? { kind, router, factory, tokenOut }
    : stable !== undefined ? { kind, router, factory, stable, tokenOut }
    : poolFee !== undefined ? { kind, router, factory, poolFee, tokenOut }
    : { kind, router, factory, tickSpacing, tokenOut };
}
export function swapPathCandidateAllowed(c: SwapPathCandidate, allowed: readonly string[]): boolean {
  const set = new Set(allowed.map(x => x.toLowerCase()));
  return c.hops.every(h => set.has(h.tokenOut.toLowerCase()));
}
