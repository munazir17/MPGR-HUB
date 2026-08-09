// lib/staking/staking-history-service.ts

import type { Address } from "viem";
import { stakingHistoryReader } from "./staking-history-reader";
import { logger } from "@/lib/architecture/core/logger";
import { MPGR_STAKING_CONFIG } from "./staking-config";
import type { StakingHistoryCacheEntry, StakingHistoryEvent } from "./staking-types";
// TEMPORARY — Phase 3F diagnostic trace only. See lib/_debug/reward-hub-trace.ts.
import { trace } from "@/lib/_debug/reward-hub-trace";

// Phase 3F Part 2 — In-flight scan dedup.
//
// Root cause of the Reward Hub's slow cold-start load: staking-rewards-
// provider.ts's getSummary() and getHistory() both call
// stakingHistoryService.getHistory() for the same wallet, and
// useRewardHub.ts's load() calls both of those (via
// rewardService.getRewardHubSummary/getRewardHistory) in one Promise.all.
// With a cold cache, both calls used to see a miss and each launch its
// own full chunked eth_getLogs scan (historyLookbackBlocks / chunkSize =
// ~100 sequential round trips per event kind) — doubling the RPC burst
// for no reason, since both calls want the exact same data.
//
// inFlightScans fixes this at the source: the actual scan-and-cache work
// is a single async operation per wallet, memoized while it's running.
// Any caller that arrives while a scan for that wallet is already in
// flight awaits the SAME promise instead of starting a second one, then
// slices the result to its own requested `limit`. This changes nothing
// about which blocks get scanned, how far back, or what results look
// like — it only removes the duplicate work. Every other consumer
// (hooks/useStakingHistory.ts, the Staking page) is unaffected: a single
// caller's behavior is identical to before.

const historyCache = new Map<string, StakingHistoryCacheEntry>();
const inFlightScans = new Map<string, Promise<StakingHistoryEvent[]>>();

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

// The actual scan-and-cache work, unchanged from before except that it's
// now a standalone function so it can be memoized per wallet in
// inFlightScans. Returns the full merged (unsliced) history — callers in
// getHistory() apply their own `limit` afterward. Never throws: on
// failure it logs and falls back to whatever was cached before this
// scan started, exactly as the previous inline implementation did.
async function scanAndCache(walletAddress: Address, cacheKey: string): Promise<StakingHistoryEvent[]> {
  const cached = historyCache.get(cacheKey);
  // TEMPORARY — Phase 3F diagnostic trace only.
  const scanAndCacheStarted = trace.start("staking-history-service.scanAndCache", {
    walletAddress,
    hadCachedEntry: !!cached,
  });

  try {
    // TEMPORARY — Phase 3F diagnostic trace only.
    const latestBlockStarted = trace.start("staking-history-reader.getLatestBlockNumber");
    const latestBlock = await stakingHistoryReader.getLatestBlockNumber();
    trace.end("staking-history-reader.getLatestBlockNumber", latestBlockStarted, { latestBlock: latestBlock.toString() });

    const lookback = BigInt(MPGR_STAKING_CONFIG.historyLookbackBlocks);
    const defaultFromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;

    const fromBlock = cached ? cached.lastBlockScanned + 1n : defaultFromBlock;

    if (cached && fromBlock > latestBlock) {
      historyCache.set(cacheKey, { ...cached, timestamp: Date.now() });
      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.end("staking-history-service.scanAndCache", scanAndCacheStarted, { skippedRescan: true });
      return cached.entries;
    }

    // TEMPORARY — Phase 3F diagnostic trace only.
    const fetchStarted = trace.start("staking-history-reader.fetchHistory", {
      fromBlock: fromBlock.toString(),
      toBlock: latestBlock.toString(),
      blockSpan: (latestBlock - fromBlock).toString(),
    });
    const newEvents = await stakingHistoryReader.fetchHistory(walletAddress, fromBlock, latestBlock);
    trace.end("staking-history-reader.fetchHistory", fetchStarted, { newEventsCount: newEvents.length });

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

    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end("staking-history-service.scanAndCache", scanAndCacheStarted, { mergedCount: merged.length });
    return merged;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("stakingHistoryService.getHistory failed", { walletAddress, error: errorMsg });
    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end("staking-history-service.scanAndCache", scanAndCacheStarted, { failed: true, error: errorMsg });
    return cached ? cached.entries : [];
  }
}

export const stakingHistoryService = {
  async getHistory(
    walletAddress: Address,
    options: { forceRefresh?: boolean; limit?: number } = {}
  ): Promise<StakingHistoryEvent[]> {
    const cacheKey = getCacheKey(walletAddress);
    const cached = historyCache.get(cacheKey);
    const limit = options.limit ?? MPGR_STAKING_CONFIG.historyPageSize;

    if (cached && !options.forceRefresh && isCacheValid(cached)) {
      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.mark("staking-history-service cache HIT", { walletAddress });
      return cached.entries.slice(0, limit);
    }

    // Dedup point: if a scan for this wallet is already running (e.g. the
    // Reward Hub's staking-rewards-provider calling getSummary() and
    // getHistory() in the same load cycle), share it instead of starting
    // a second full chunked scan. Registration happens synchronously
    // before any `await`, so two calls arriving in the same Promise.all
    // reliably see each other.
    const existingScan = inFlightScans.get(cacheKey);
    if (existingScan) {
      // TEMPORARY — Phase 3F diagnostic trace only. Confirms/denies
      // dedup: this line firing means a second concurrent caller
      // correctly joined the in-flight scan instead of starting a new one.
      trace.mark("staking-history-service DEDUP HIT (joined in-flight scan)", { walletAddress });
      const merged = await existingScan;
      return merged.slice(0, limit);
    }

    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.mark("staking-history-service cache MISS, starting new scan", { walletAddress, forceRefresh: options.forceRefresh });
    const scanPromise = scanAndCache(walletAddress, cacheKey).finally(() => {
      inFlightScans.delete(cacheKey);
    });
    inFlightScans.set(cacheKey, scanPromise);

    const merged = await scanPromise;
    return merged.slice(0, limit);
  },

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
