// lib/rewards/reward-service.ts

import type { Address } from "viem";
import { REWARD_CATEGORY_METADATA, MPGR_REWARDS_CONFIG } from "./reward-config";
import { REWARD_PROVIDERS, getProviderForCategory } from "./providers";
import type {
  RewardCategoryKey,
  RewardCategorySummary,
  RewardClaimHistoryEntry,
  RewardHistoryCacheEntry,
  RewardHubCacheEntry,
  RewardHubSummary,
} from "./reward-types";

// Phase 3F Part 1 — Reward Service.
//
// Caching + aggregation layer over lib/rewards/providers/, mirroring
// lib/staking/staking-service.ts's shape exactly: cache-first reads, a
// short TTL, manual invalidation. Every number in the returned
// RewardHubSummary/RewardClaimHistoryEntry[] traces back to a real
// provider read — nothing is computed or estimated here beyond summing
// what the providers returned. A category from
// reward-config.ts's REWARD_CATEGORY_METADATA that has no registered
// provider (see lib/rewards/providers/index.ts) is included in the
// summary with isActive: false and zeroed amounts — never silently
// omitted, and never a fabricated non-zero number.

const ALL_CATEGORIES = Object.keys(REWARD_CATEGORY_METADATA) as RewardCategoryKey[];

const hubCache = new Map<string, RewardHubCacheEntry>();
const historyCache = new Map<string, RewardHistoryCacheEntry>();

function cacheKey(address: Address): string {
  return address.toLowerCase();
}

function isCacheValid(timestamp: number, ttl: number): boolean {
  return Date.now() - timestamp < ttl;
}

function inactiveSummary(category: RewardCategoryKey): RewardCategorySummary {
  return {
    category,
    label: REWARD_CATEGORY_METADATA[category].label,
    isActive: false,
    totalEarnedRaw: 0n,
    claimedRaw: 0n,
    claimableRaw: 0n,
  };
}

export const rewardService = {
  // Aggregated summary across every category on the roadmap. Categories
  // with a registered provider are read live (through that provider's own
  // caching); categories without one yet come back isActive: false.
  async getRewardHubSummary(address: Address, options: { forceRefresh?: boolean } = {}): Promise<RewardHubSummary> {
    const key = cacheKey(address);
    const cached = hubCache.get(key);
    if (cached && !options.forceRefresh && isCacheValid(cached.timestamp, cached.ttl)) {
      return cached.summary;
    }

    const categorySummaries = await Promise.all(
      ALL_CATEGORIES.map(async (category) => {
        const provider = getProviderForCategory(category);
        if (!provider) return inactiveSummary(category);
        try {
          return await provider.getSummary(address);
        } catch {
          // A single misbehaving provider must never take down the whole
          // hub — degrade that one category to inactive rather than
          // throwing past this point, matching lib/staking's "reads
          // throw, callers decide how to degrade" convention applied at
          // the aggregation boundary.
          return inactiveSummary(category);
        }
      })
    );

    const summary: RewardHubSummary = {
      totalEarnedRaw: categorySummaries.reduce((sum, c) => sum + c.totalEarnedRaw, 0n),
      totalClaimedRaw: categorySummaries.reduce((sum, c) => sum + c.claimedRaw, 0n),
      totalClaimableRaw: categorySummaries.reduce((sum, c) => sum + c.claimableRaw, 0n),
      categories: categorySummaries,
    };

    hubCache.set(key, { summary, timestamp: Date.now(), ttl: MPGR_REWARDS_CONFIG.hubCacheTtl });
    return summary;
  },

  // Merged claim history across every active category, newest-first.
  async getRewardHistory(
    address: Address,
    options: { forceRefresh?: boolean; limit?: number } = {}
  ): Promise<RewardClaimHistoryEntry[]> {
    const key = cacheKey(address);
    const cached = historyCache.get(key);
    const limit = options.limit ?? MPGR_REWARDS_CONFIG.historyPageSize;

    if (cached && !options.forceRefresh && isCacheValid(cached.timestamp, cached.ttl)) {
      return cached.entries.slice(0, limit);
    }

    const perProvider = await Promise.all(
      REWARD_PROVIDERS.map(async (provider) => {
        try {
          return await provider.getHistory(address);
        } catch {
          return [] as RewardClaimHistoryEntry[];
        }
      })
    );

    const merged = perProvider
      .flat()
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    historyCache.set(key, { entries: merged, timestamp: Date.now(), ttl: MPGR_REWARDS_CONFIG.historyCacheTtl });
    return merged.slice(0, limit);
  },

  getCachedRewardHubSummary(address: Address): RewardHubSummary | null {
    const cached = hubCache.get(cacheKey(address));
    return cached && isCacheValid(cached.timestamp, cached.ttl) ? cached.summary : null;
  },

  getCachedRewardHistory(address: Address): RewardClaimHistoryEntry[] | null {
    const cached = historyCache.get(cacheKey(address));
    return cached && isCacheValid(cached.timestamp, cached.ttl) ? cached.entries : null;
  },

  clearCache(address: Address): void {
    const key = cacheKey(address);
    hubCache.delete(key);
    historyCache.delete(key);
  },

  clearAllCache(): void {
    hubCache.clear();
    historyCache.clear();
  },
} as const;
