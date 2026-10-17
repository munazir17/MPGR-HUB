// Swap-only capabilities: registration is a prerequisite, never proof of liquidity.
import { isAddress } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment, findExecutorRoute, findExecutorToken, RouterKind } from "@/lib/executor/executor-config";
import { BASE_WETH, isNativeEthSentinel, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import { manualSwapInputError, type ManualSwapInput } from "@/lib/trade/manual-swap";
import type { TradeTokenRef } from "@/lib/trade/trade-types";

export const swapPoolAsset = (address: string) => isNativeEthSentinel(address) ? BASE_WETH.toLowerCase() : address.toLowerCase();
const assisted = (kind: number) => kind === RouterKind.UNISWAP_V3_ROUTER02 || kind === RouterKind.AERODROME_SLIPSTREAM;
const label = (address: string) => findKnownTradeToken(address)?.symbol ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
export function swapPairIssue(from: string, to: string): { code: string; message: string } | null {
  if (!isAddress(from, { strict: false }) || !isAddress(to, { strict: false })) return { code: "INVALID_ADDRESS", message: "Select exact Base token addresses before requesting a quote." };
  if (swapPoolAsset(from) === swapPoolAsset(to)) return { code: "SAME_ASSET", message: "Choose different underlying assets. ETH and WETH are not offered as a swap or wrap/unwrap trade." };
  return null;
}
export function swapRouteIssue(from: string, to: string): { code: string; message: string } | null {
  const invalid = swapPairIssue(from, to); if (invalid) return invalid;
  const sell = swapPoolAsset(from), buy = swapPoolAsset(to);
  const route = findExecutorRoute(deployment, sell, buy);
  if (!findExecutorToken(deployment, sell) || !findExecutorToken(deployment, buy) || !route || !assisted(route.kind)) {
    return { code: "FEE_ROUTE_UNREGISTERED", message: `${label(from)} → ${label(to)} has no approved atomic-fee route configured in MPGR Swap. Route/allowlist verification is required; no approval or swap was requested. This does not establish whether external liquidity exists.` };
  }
  return null;
}
export function swapCounterassets(address: string): string[] {
  const asset = swapPoolAsset(address);
  const others = deployment.routes.filter(r => assisted(r.kind))
    .flatMap(r => r.tokenA.toLowerCase() === asset ? [r.tokenB] : r.tokenB.toLowerCase() === asset ? [r.tokenA] : []);
  return [...new Set(others.flatMap(a => a.toLowerCase() === BASE_WETH.toLowerCase() ? [a, NATIVE_ETH_SENTINEL] : [a]))];
}
export function swapInputError(input: ManualSwapInput, tokens?: readonly TradeTokenRef[]): string | null {
  return swapPairIssue(input.fromToken, input.toToken)?.message ?? manualSwapInputError(input, tokens);
}
