import manifest from "./token-logos.json";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { TRADE_CHAIN_ID } from "@/lib/trade/trade-config";

// Immutable, locally cached artwork. No runtime image URL from a symbol,
// imported metadata, wallet chain, or provider response is ever loaded.
const logos: Readonly<Record<string, { kind: string; src: string }>> = manifest.tokens;
export function swapTokenLogo(token: TradeTokenRef, chainId: number = TRADE_CHAIN_ID): string | null {
  if (chainId !== 8453 || !token.verified) return null;
  const asset = logos[token.address.toLowerCase()];
  return asset?.kind === token.kind ? asset.src : null;
}
