// lib/rewards/reward-service.ts

import type { Address } from "viem";
import { REWARD_PROVIDERS } from "./providers";
import { trace } from "@/lib/_debug/reward-hub-trace";
import type {
  RewardClaimHistoryEntry,
  RewardHubCacheEntry,
  RewardHubSummary,
  RewardHistoryCacheEntry,
} from "./reward-types";
import { MPGR_REWARDS_CONFIG } from "./reward-config";

const summaryCache = new Map<string, RewardHubCacheEntry>();
const historyCache = new Map<string, RewardHistoryCacheEntry>();

function getCacheKey(address: Address): string {
  return address.toLowerCase();
}

function isCacheValid<T extends { timestamp: number; ttl: number }>(
  entry: T
): boolean {
  return Date.now() - entry.timestamp < entry.ttl;
}

export const rewardService = {
  async getRewardHubSummary(
    address: Address,
    options: { forceRefresh?: boolean } = {}
  ): Promise<RewardHubSummary> {
    const started = trace.start("rewardService.getRewardHubSummary", {
      address,
      forceRefresh: options.forceRefresh,
    });

    const cacheKey = getCacheKey(address);
    const cached = summaryCache.get(cacheKey);

    if (cached && !options.forceRefresh && isCacheValid(cached)) {
      trace.mark("rewardService.getRewardHubSummary CACHE HIT", {
        address,
      });

      trace.end("rewardService.getRewardHubSummary", started, {
        address,
        cache: "hit",
      });

      return cached.summary;
    }

    trace.mark("rewardService.getRewardHubSummary CACHE MISS", {
      address,
      forceRefresh: options.forceRefresh,
    });

    const providerResults = await Promise.all(
      REWARD_PROVIDERS.map(async (provider) => {
        const providerStarted = trace.start(
          `provider.getSummary:${provider.category}`,
          {
            address,
            category: provider.category,
            label: provider.label,
          }
        );

        try {
          const result = await provider.getSummary(address);

          trace.end(
            `provider.getSummary:${provider.category}`,
            providerStarted,
            {
              address,
              category: provider.category,
              isActive: result.isActive,
              claimedRaw: result.claimedRaw.toString(),
              claimableRaw: result.claimableRaw.toString(),
              totalEarnedRaw: result.totalEarnedRaw.toString(),
            }
          );

          return result;
        } catch (error) {
          trace.end(
            `provider.getSummary:${provider.category}`,
            providerStarted,
            {
              address,
              category: provider.category,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            }
          );

          throw error;
        }
      })
    );

    const aggregationStarted = trace.start(
      "rewardService.getRewardHubSummary aggregation",
      {
        address,
        providerCount: providerResults.length,
      }
    );

    const totalEarnedRaw = providerResults.reduce(
      (total, category) => total + category.totalEarnedRaw,
      0n
    );

    const totalClaimedRaw = providerResults.reduce(
      (total, category) => total + category.claimedRaw,
      0n
    );

    const totalClaimableRaw = providerResults.reduce(
      (total, category) => total + category.claimableRaw,
      0n
    );

    const summary: RewardHubSummary = {
      totalEarnedRaw,
      totalClaimedRaw,
      totalClaimableRaw,
      categories: providerResults,
    };

    trace.end(
      "rewardService.getRewardHubSummary aggregation",
      aggregationStarted,
      {
        address,
        providerCount: providerResults.length,
      }
    );

    summaryCache.set(cacheKey, {
      summary,
      timestamp: Date.now(),
      ttl: MPGR_REWARDS_CONFIG.summaryCacheTtl,
    });

    trace.end("rewardService.getRewardHubSummary", started, {
      address,
      cache: "miss",
      providerCount: providerResults.length,
    });

    return summary;
  },

  async getRewardHistory(
    address: Address,
    options: {
      forceRefresh?: boolean;
      limit?: number;
    } = {}
  ): Promise<RewardClaimHistoryEntry[]> {
    const started = trace.start("rewardService.getRewardHistory", {
      address,
      limit: options.limit,
      forceRefresh: options.forceRefresh,
    });

    const cacheKey = getCacheKey(address);
    const cached = historyCache.get(cacheKey);
    const limit =
      options.limit ?? MPGR_REWARDS_CONFIG.historyPageSize;

    if (cached && !options.forceRefresh && isCacheValid(cached)) {
      trace.mark("rewardService.getRewardHistory CACHE HIT", {
        address,
        limit,
        cachedEntries: cached.entries.length,
      });

      trace.end("rewardService.getRewardHistory", started, {
        address,
        cache: "hit",
        entries: cached.entries.length,
      });

      return cached.entries.slice(0, limit);
    }

    trace.mark("rewardService.getRewardHistory CACHE MISS", {
      address,
      limit,
      forceRefresh: options.forceRefresh,
    });

    const providerResults = await Promise.all(
      REWARD_PROVIDERS.map(async (provider) => {
        const providerStarted = trace.start(
          `provider.getHistory:${provider.category}`,
          {
            address,
            category: provider.category,
            label: provider.label,
            limit,
          }
        );

        try {
          const entries = await provider.getHistory(
            address,
            limit
          );

          trace.end(
            `provider.getHistory:${provider.category}`,
            providerStarted,
            {
              address,
              category: provider.category,
              entries: entries.length,
            }
          );

          return entries;
        } catch (error) {
          trace.end(
            `provider.getHistory:${provider.category}`,
            providerStarted,
            {
              address,
              category: provider.category,
              error:
                error instanceof Error
                  ? error.message
                  : String(error),
            }
          );

          throw error;
        }
      })
    );

    const aggregationStarted = trace.start(
      "rewardService.getRewardHistory aggregation",
      {
        address,
        providerCount: providerResults.length,
      }
    );

    const merged = providerResults
      .flat()
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() -
          new Date(a.timestamp).getTime()
      );

    const entries = merged.slice(0, limit);

    trace.end(
      "rewardService.getRewardHistory aggregation",
      aggregationStarted,
      {
        address,
        providerCount: providerResults.length,
        mergedEntries: merged.length,
        returnedEntries: entries.length,
      }
    );

    historyCache.set(cacheKey, {
      entries: merged,
      timestamp: Date.now(),
      ttl: MPGR_REWARDS_CONFIG.historyCacheTtl,
    });

    trace.end("rewardService.getRewardHistory", started, {
      address,
      cache: "miss",
      providerCount: providerResults.length,
      returnedEntries: entries.length,
    });

    return entries;
  },

  getCachedRewardSummary(
    address: Address
  ): RewardHubSummary | null {
    const cached = summaryCache.get(getCacheKey(address));

    if (!cached || !isCacheValid(cached)) {
      return null;
    }

    return cached.summary;
  },

  getCachedRewardHistory(
    address: Address
  ): RewardClaimHistoryEntry[] | null {
    const cached = historyCache.get(getCacheKey(address));

    if (!cached || !isCacheValid(cached)) {
      return null;
    }

    return cached.entries;
  },

  clearCache(address: Address): void {
    const cacheKey = getCacheKey(address);

    summaryCache.delete(cacheKey);
    historyCache.delete(cacheKey);
  },

  clearAllCache(): void {
    summaryCache.clear();
    historyCache.clear();
  },
} as const;
