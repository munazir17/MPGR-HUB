// lib/staking/staking-history-service.ts

import type { Address } from "viem";
import { stakingHistoryReader } from "./staking-history-reader";
import { logger } from "@/lib/architecture/core/logger";
import { MPGR_STAKING_CONFIG } from "./staking-config";
import type { StakingHistoryCacheEntry, StakingHistoryEvent } from "./staking-types";

// Phase 3E Part 4 — Staking History Service.
//
// Sits on top of staking-history-reader.ts exactly the way
// lib/token/transaction-history-service.ts sits on top of
// transfer-event-reader.ts: owns caching, incremental scanning (only
// asks the reader for blocks it hasn't seen yet), and dedup across
// scans. Deliberately does not emit onto the shared agentEventBus —
// hooks/useStakingHistory.ts already gets its refresh signal from the
// existing "staking_changed" event that refreshManager.refreshStaking
// emits after every confirmed staking action (see hooks/useStaking.ts),
// so adding a second event here would just duplicate that signal.

const historyCache = new Map<string, StakingHistoryCacheEntry>();

function getCacheKey(walletAddress: Address): string {
  return `staking-history:${walletAddress.toLowerCase()}`;
}

function isCacheValid(entry: StakingHistoryCacheEntry): boolean {
  return Date.now() - entry.timestamp < entry.ttl;
}

function mergeAndSort(existing: StakingHistoryEvent[], incoming: StakingHistoryEvent[]): StakingHistoryEvent[] {
  const byId = new Map<string, StakingHistoryEvent>();
  for (const event of [...existing, ...incoming]) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) =>
    a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0
  );
}

export const stakingHistoryService = {
  // Returns the wallet's Staked/Unstaked/RewardPaid history, newest-first,
  // refreshing from chain only for the block range not yet scanned. Pass
  // forceRefresh to ignore the cache TTL. Never throws — degrades to
  // cached (even stale) data on RPC failure, or an empty list if nothing
  // is cached yet.
  async getHistory(
    walletAddress: Address,
    options: { forceRefresh?: boolean; limit?: number } = {}
  ): Promise<StakingHistoryEvent[]> {
    const cacheKey = getCacheKey(walletAddress);
    const cached = historyCache.get(cacheKey);
    const limit = options.limit ?? MPGR_STAKING_CONFIG.historyPageSize;

    if (cached && !options.forceRefresh && isCacheValid(cached)) {
      return cached.entries.slice(0, limit);
    }

    try {
      const latestBlock = await stakingHistoryReader.getLatestBlockNumber();
      const lookback = BigInt(MPGR_STAKING_CONFIG.historyLookbackBlocks);
      const defaultFromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;

      const fromBlock = cached ? cached.lastBlockScanned + 1n : defaultFromBlock;

      if (cached && fromBlock > latestBlock) {
        historyCache.set(cacheKey, { ...cached, timestamp: Date.now() });
        return cached.entries.slice(0, limit);
      }

      const newEvents = await stakingHistoryReader.fetchHistory(walletAddress, fromBlock, latestBlock);
      const merged = mergeAndSort(cached?.entries ?? [], newEvents);

      historyCache.set(cacheKey, {
        entries: merged,
        timestamp: Date.now(),
        ttl: MPGR_STAKING_CONFIG.historyCacheTtl,
        lastBlockScanned: latestBlock,
      });

      if (newEvents.length > 0) {
        logger.debug("stakingHistoryService.getHistory found new staking events", {
          walletAddress,
          newCount: newEvents.length,
        });
      }

      return merged.slice(0, limit);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("stakingHistoryService.getHistory failed", { walletAddress, error: errorMsg });
      return cached ? cached.entries.slice(0, limit) : [];
    }
  },

  // All entries currently cached for a wallet (unbounded by page size) —
  // used to sum "Total Rewards Claimed" over the full cached history and
  // to compute hasMore for pagination, mirroring
  // transactionHistoryService.getCachedHistory's role.
  getCachedHistory(walletAddress: Address): StakingHistoryEvent[] | null {
    const cached = historyCache.get(getCacheKey(walletAddress));
    return cached && isCacheValid(cached) ? cached.entries : null;
  },

  clearCache(walletAddress: Address): void {
    historyCache.delete(getCacheKey(walletAddress));
  },

  clearAllCache(): void {
    historyCache.clear();
  },
} as const;
