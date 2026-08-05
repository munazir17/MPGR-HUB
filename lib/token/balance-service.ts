// lib/token/balance-service.ts

import { tokenClient } from "./token-client";
import { tokenUtils } from "./token-utils";
import { MPGR_TOKEN_CONFIG } from "./token-config";
import type { TokenBalance, BalanceCacheEntry } from "./token-types";
import type { Address } from "viem";

// Phase 3E Part 1 — Balance Service.
//
// Manages fetching, caching, and formatting wallet MPGR balances. Called by
// hooks and transaction-service. Handles cache expiration, fallback on errors,
// and metric recording (via logger, not here).

const balanceCache = new Map<string, BalanceCacheEntry>();

function getCacheKey(walletAddress: Address): string {
  return `balance:${walletAddress.toLowerCase()}`;
}

function isCacheValid(entry: BalanceCacheEntry): boolean {
  return Date.now() - entry.timestamp < entry.ttl;
}

export const balanceService = {
  // Fetches the raw balance in smallest units (bigint). Checks cache first;
  // if expired or missing, fetches from RPC. Never throws — returns 0n on error.
  async getRawBalance(walletAddress: Address): Promise<bigint> {
    try {
      const cacheKey = getCacheKey(walletAddress);
      const cached = balanceCache.get(cacheKey);

      if (cached && isCacheValid(cached)) {
        return cached.balance.raw;
      }

      const rawBalance = await tokenClient.getBalanceRaw(walletAddress);
      const balance: TokenBalance = {
        raw: rawBalance,
        formatted: tokenClient.formatBalance(rawBalance, MPGR_TOKEN_CONFIG.decimals),
        decimal: MPGR_TOKEN_CONFIG.decimals,
      };

      balanceCache.set(cacheKey, {
        balance,
        timestamp: Date.now(),
        ttl: MPGR_TOKEN_CONFIG.balanceCacheTtl,
      });

      return rawBalance;
    } catch (err) {
      console.error("balanceService.getRawBalance failed", { walletAddress, error: err });
      return 0n;
    }
  },

  // Fetches the formatted balance as a decimal string.
  async getFormattedBalance(walletAddress: Address): Promise<string> {
    const raw = await this.getRawBalance(walletAddress);
    return tokenClient.formatBalance(raw, MPGR_TOKEN_CONFIG.decimals);
  },

  // Fetches the abbreviated balance for compact display ("1.23M" style).
  async getAbbreviatedBalance(walletAddress: Address): Promise<string> {
    const raw = await this.getRawBalance(walletAddress);
    return tokenUtils.abbreviateBalance(raw, MPGR_TOKEN_CONFIG.decimals);
  },

  // Returns cached balance if valid, otherwise returns null (caller decides
  // if they want to fetch fresh). Useful for "show stale data while refreshing".
  getCachedBalance(walletAddress: Address): TokenBalance | null {
    const cacheKey = getCacheKey(walletAddress);
    const cached = balanceCache.get(cacheKey);
    return cached && isCacheValid(cached) ? cached.balance : null;
  },

  // Manually clear cache for a single wallet (useful after transactions).
  clearCache(walletAddress: Address): void {
    const cacheKey = getCacheKey(walletAddress);
    balanceCache.delete(cacheKey);
  },

  // Manually clear ALL balance cache (rarely needed, but useful for tests
  // or if cache becomes corrupted).
  clearAllCache(): void {
    balanceCache.clear();
  },
} as const;
