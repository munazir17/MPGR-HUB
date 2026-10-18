import manifest from "./token-logos.json";
import type { TradeTokenRef } from "@/lib/trade/trade-types";
import { TRADE_CHAIN_ID } from "@/lib/trade/trade-config";

// Immutable, locally cached artwork keyed by Base chain id + exact normalized
// contract address + token kind. No runtime image URL from a symbol, imported
// metadata, wallet chain, or provider response is ever loaded, so a lookalike
// symbol can never borrow another token's logo. Results are memoized and the
// bundled assets are served by the app itself: there are no remote logo
// requests to deduplicate, retry or cache-bust at runtime.
const logos: Readonly<Record<string, { kind: string; src: string }>> = manifest.tokens;
const cache = new Map<string, string | null>();
export function swapTokenLogo(token: TradeTokenRef, chainId: number = TRADE_CHAIN_ID): string | null {
  if (chainId !== 8453 || !token.verified) return null;
  const key = `${token.address.toLowerCase()}:${token.kind}`;
  if (!cache.has(key)) {
    const asset = logos[token.address.toLowerCase()];
    cache.set(key, asset?.kind === token.kind ? asset.src : null);
  }
  return cache.get(key) ?? null;
}
/** Manifest fact for tests/docs: which addresses carry vetted artwork. */
export const swapTokenLogoCoverage = (): readonly string[] => Object.keys(logos);
