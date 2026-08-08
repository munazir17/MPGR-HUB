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
// TEMPORARY — Phase 3F diagnostic trace only. See lib/_debug/reward-hub-trace.ts.
import { trace } from "@/lib/_debug/reward-hub-trace";

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
      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.mark("getRewardHubSummary cache HIT", { address });
      return cached.summary;
    }
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.mark("getRewardHubSummary cache MISS", { address, forceRefresh: options.forceRefresh });
    const summaryStarted = trace.start("getRewardHubSummary aggregation");

    const categorySummaries = await Promise.all(
      ALL_CATEGORIES.map(async (category) => {
        const provider = getProviderForCategory(category);
        if (!provider) return inactiveSummary(category);
        try {
          // TEMPORARY — Phase 3F diagnostic trace only.
          const s = trace.start(`provider ${category}.getSummary`);
          const result = await provider.getSummary(address);
          trace.end(`provider ${category}.getSummary`, s);
          return result;
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
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end("getRewardHubSummary aggregation", summaryStarted);
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
      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.mark("getRewardHistory cache HIT", { address });
      return cached.entries.slice(0, limit);
    }
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.mark("getRewardHistory cache MISS", { address, forceRefresh: options.forceRefresh });
    const historyStarted = trace.start("getRewardHistory aggregation");

    const perProvider = await Promise.all(
      REWARD_PROVIDERS.map(async (provider) => {
        try {
          // TEMPORARY — Phase 3F diagnostic trace only.
          const s = trace.start(`provider ${provider.category}.getHistory`);
          const result = await provider.getHistory(address);
          trace.end(`provider ${provider.category}.getHistory`, s, { count: result.length });
          return result;
        } catch {
          return [] as RewardClaimHistoryEntry[];
        }
      })
    );

    const merged = perProvider
      .flat()
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    historyCache.set(key, { entries: merged, timestamp: Date.now(), ttl: MPGR_REWARDS_CONFIG.historyCacheTtl });
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end("getRewardHistory aggregation", historyStarted, { mergedCount: merged.length });
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
