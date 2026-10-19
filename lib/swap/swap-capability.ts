// Swap-only capabilities: registration is a prerequisite, never proof of liquidity.
import { isAddress } from "viem";
import { BASE_MAINNET_EXECUTOR_DEPLOYMENT as deployment, findExecutorRoute, findExecutorToken } from "@/lib/executor/executor-config";
import { BASE_WETH, isNativeEthSentinel, NATIVE_ETH_SENTINEL } from "@/lib/trade/trade-config";
import { findKnownTradeToken } from "@/lib/trade/trade-tokens";
import { manualSwapInputError, type ManualSwapInput } from "@/lib/trade/manual-swap";
import type { TradeTokenRef } from "@/lib/trade/trade-types";

export const swapPoolAsset = (address: string) => isNativeEthSentinel(address) ? BASE_WETH.toLowerCase() : address.toLowerCase();
const label = (address: string) => findKnownTradeToken(address)?.symbol ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
export function swapPairIssue(from: string, to: string): { code: string; message: string } | null {
  if (!isAddress(from, { strict: false }) || !isAddress(to, { strict: false })) return { code: "INVALID_ADDRESS", message: "Select exact Base token addresses before requesting a quote." };
  if (swapPoolAsset(from) === swapPoolAsset(to)) return { code: "SAME_ASSET", message: "Choose different underlying assets. ETH and WETH are not offered as a swap or wrap/unwrap trade." };
  return null;
}
export function swapRouteIssue(from: string, to: string): { code: string; message: string } | null {
  const invalid = swapPairIssue(from, to); if (invalid) return invalid;
  const sell = swapPoolAsset(from), buy = swapPoolAsset(to);
  if (!findExecutorToken(deployment, sell) || !findExecutorToken(deployment, buy)) {
    return { code: "FEE_ROUTE_UNREGISTERED", message: `${label(from)} → ${label(to)} is not supported in MPGR Swap yet. Token and route checks are still required before trading here. External liquidity has not been checked. No approval or swap was requested.` };
  }
  return null;
}
export function swapCounterassets(address: string): string[] {
  const asset = swapPoolAsset(address);
  if (!findExecutorToken(deployment, asset)) return [];
  const others = deployment.tokens.filter(t => t.address.toLowerCase() !== asset).map(t => t.address);
  return [...new Set(others.flatMap(a => a.toLowerCase() === BASE_WETH.toLowerCase() ? [a, NATIVE_ETH_SENTINEL] : [a]))];
}
export function swapInputError(input: ManualSwapInput, tokens?: readonly TradeTokenRef[]): string | null {
  return swapPairIssue(input.fromToken, input.toToken)?.message ?? manualSwapInputError(input, tokens);
}

/** UI facts only: metadata validation never grants routing or on-chain permission. */
export function swapCapabilityStatus(from: string, to: string, metadataValidated = false) {
  const issue = swapRouteIssue(from, to);
  if (!issue) {
    const registered = findExecutorRoute(deployment, swapPoolAsset(from), swapPoolAsset(to));
    return registered ? { code: "REGISTERED_UNQUOTED", selectable: true, message: "Get a live quote to check availability. Trading is not confirmed yet." } :
      { code: "SEARCH_REQUIRED", selectable: true, message: "Get a live quote to find a direct swap. This pair may need a multi-step route, which is not supported yet." };
  }
  if (issue.code === "SAME_ASSET") return { code: "SAME_ASSET", selectable: false, message: "Same underlying asset — choose a different receive token." };
  const asset = from;
  const others = swapCounterassets(asset);
  if (others.length) return { code: "COUNTERASSET_REQUIRED", selectable: false, message: `This pair is not supported yet. Try a live quote with: ${others.map(label).join(", ")}. Change the other asset explicitly.` };
  return { code: "REGISTRATION_REQUIRED", selectable: false, message: `${metadataValidated ? "Token details checked" : "Token available to look up"} — trading is not supported in MPGR Swap yet. Finding a token or pool does not make it tradable here.` };
}
