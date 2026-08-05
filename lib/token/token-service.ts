// lib/token/token-service.ts

import { tokenClient } from "./token-client";
import { MPGR_TOKEN_CONFIG } from "./token-config";
import type { TokenMetadata, MetadataCacheEntry } from "./token-types";

// Phase 3E Part 1 — Token Service.
//
// Manages token-wide metadata (name, symbol, decimals, total supply).
// This data changes rarely (only on contract upgrades), so caching for
// a full hour is safe. Called by hooks and used to build UI labels.

const metadataCache = new Map<string, MetadataCacheEntry>();

function isCacheValid(entry: MetadataCacheEntry): boolean {
  return Date.now() - entry.timestamp < entry.ttl;
}

export const tokenService = {
  // Fetches all metadata at once (name, symbol, decimals, totalSupply).
  // Caches the result for MPGR_TOKEN_CONFIG.metadataCacheTtl (1 hour).
  async getMetadata(): Promise<TokenMetadata> {
    const cacheKey = "metadata";
    const cached = metadataCache.get(cacheKey);

    if (cached && isCacheValid(cached)) {
      return cached.metadata;
    }

    try {
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        tokenClient.getName(),
        tokenClient.getSymbol(),
        tokenClient.getDecimals(),
        tokenClient.getTotalSupply(MPGR_TOKEN_CONFIG.decimals),
      ]);

      const metadata: TokenMetadata = {
        name,
        symbol,
        decimals,
        address: MPGR_TOKEN_CONFIG.address,
        totalSupply,
      };

      metadataCache.set(cacheKey, {
        metadata,
        timestamp: Date.now(),
        ttl: MPGR_TOKEN_CONFIG.metadataCacheTtl,
      });

      return metadata;
    } catch (err) {
      console.error("tokenService.getMetadata failed", { error: err });
      // Fallback to compile-time defaults.
      return {
        name: MPGR_TOKEN_CONFIG.name,
        symbol: MPGR_TOKEN_CONFIG.symbol,
        decimals: MPGR_TOKEN_CONFIG.decimals,
        address: MPGR_TOKEN_CONFIG.address,
        totalSupply: 0n,
      };
    }
  },

  // Fetches just the symbol (reuses metadata cache if already loaded).
  async getSymbol(): Promise<string> {
    const metadata = await this.getMetadata();
    return metadata.symbol;
  },

  // Fetches just the name (reuses metadata cache if already loaded).
  async getName(): Promise<string> {
    const metadata = await this.getMetadata();
    return metadata.name;
  },

  // Fetches just the decimals (reuses metadata cache if already loaded).
  async getDecimals(): Promise<number> {
    const metadata = await this.getMetadata();
    return metadata.decimals;
  },

  // Fetches just the total supply (reuses metadata cache if already loaded).
  async getTotalSupply(): Promise<bigint> {
    const metadata = await this.getMetadata();
    return metadata.totalSupply;
  },

  // Clear metadata cache (rarely needed, but useful after upgrades or tests).
  clearCache(): void {
    metadataCache.clear();
  },
} as const;
