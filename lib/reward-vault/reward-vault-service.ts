// lib/reward-vault/reward-vault-service.ts

import type { Address } from "viem";
import { rewardVaultClient } from "./reward-vault-client";
import { MPGR_REWARD_VAULT_CONFIG } from "./reward-vault-config";
import type { VaultReward, VaultWalletCacheEntry } from "./reward-vault-types";

// Reward Vault Integration — Reward Vault Service.
//
// Caching layer over reward-vault-client.ts, mirroring
// lib/staking/staking-service.ts's shape (cache-first reads, short TTL,
// manual invalidation after a confirmed transaction). Every value
// returned is exactly what reward-vault-client read from the deployed
// MPGRRewardVault contract on Base Mainnet — no fabricated data, nothing
// hardcoded. Reward IDs for a wallet are dynamically discovered via
// getUserRewardIds(); rewardId=1 (the on-chain test reward) is never
// hardcoded anywhere in this module.

const walletCache = new Map<string, VaultWalletCacheEntry>();

function walletCacheKey(address: Address): string {
  return `reward-vault:wallet:${address.toLowerCase()}`;
}

function isCacheValid(timestamp: number, ttl: number): boolean {
  return Date.now() - timestamp < ttl;
}

export const rewardVaultService = {
  // Every reward ever allocated to this wallet (both ALLOCATED and
  // CLAIMED), fetched dynamically from the chain — never hardcoded.
  async getWalletRewards(address: Address): Promise<VaultReward[]> {
    const cacheKey = walletCacheKey(address);
    const cached = walletCache.get(cacheKey);
    if (cached && isCacheValid(cached.timestamp, cached.ttl)) {
      return cached.rewards;
    }

    const rewardIds = await rewardVaultClient.getUserRewardIds(address);
    const rewards = await Promise.all(rewardIds.map((id) => rewardVaultClient.getReward(id)));

    walletCache.set(cacheKey, {
      rewards,
      timestamp: Date.now(),
      ttl: MPGR_REWARD_VAULT_CONFIG.readCacheTtl,
    });

    return rewards;
  },

  getCachedWalletRewards(address: Address): VaultReward[] | null {
    const cached = walletCache.get(walletCacheKey(address));
    return cached && isCacheValid(cached.timestamp, cached.ttl) ? cached.rewards : null;
  },

  clearWalletCache(address: Address): void {
    walletCache.delete(walletCacheKey(address));
  },

  clearAllCache(): void {
    walletCache.clear();
  },
} as const;
