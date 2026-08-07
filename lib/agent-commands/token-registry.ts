// Phase 3A.6 — Token Lookup.
//
// Local/mock, matching the exact pattern the rest of this codebase uses
// for pre-chain data (see lib/burn-utils.ts — it documents its own
// "Phase 2B swap point" for when a live contract/price feed exists).
// This is that same pattern applied to
// token metadata: static today, swappable for an on-chain/price-API
// lookup later without changing this file's exported shape.

export interface TokenInfo {
  symbol: string;
  name: string;
  chain: string;
  description: string;
  isNative: boolean;
}

// Phase 3B swap point: once a price feed / on-chain token registry
// exists, replace this Record with a fetch() call — lookupToken()'s
// signature and return shape stay the same either way.
const TOKEN_REGISTRY: Record<string, TokenInfo> = {
  mpgr: {
    symbol: "MPGR",
    name: "MoneyPaiger",
    chain: "Base",
    description: "The native token of the MPGR ecosystem — stake it, lock it, or hold it toward Holder Tier and Premium status.",
    isNative: true,
  },
  eth: {
    symbol: "ETH",
    name: "Ether",
    chain: "Base",
    description: "Base's native gas token, used to pay transaction fees for staking, locking, and claiming.",
    isNative: false,
  },
  usdc: {
    symbol: "USDC",
    name: "USD Coin",
    chain: "Base",
    description: "A USD-pegged stablecoin available on Base.",
    isNative: false,
  },
};

export function lookupToken(symbol: string): TokenInfo | null {
  return TOKEN_REGISTRY[symbol.trim().toLowerCase()] ?? null;
}

export function listKnownTokenSymbols(): string[] {
  return Object.values(TOKEN_REGISTRY).map((t) => t.symbol);
}
