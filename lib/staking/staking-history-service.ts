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
// own full chunked eth_getLogs scan — doubling the RPC burst for no
// reason, since both calls want the exact same data.
//
// inFlightScans fixes this at the source: the actual scan-and-cache work
// is a single async operation per wallet, memoized while it's running.
// Any caller that arrives while a scan for that wallet is already in
// flight awaits the SAME promise instead of starting a second one, then
// slices the result to its own requested `limit`. Every other consumer
// (hooks/useStakingHistory.ts, the Staking page) is unaffected: a single
// caller's behavior is identical to before. Unchanged by Phase 3G below.
//
// Phase 3G — incremental backward backfill (Alchemy Free-tier fit).
//
// scanAndCache() no longer scans the full historyLookbackBlocks window in
// one call. On a wallet's first-ever scan (no cache entry) it scans only
// a small historyInitialWindowBlocks window for a fast first result. On
// every subsequent call, it still catches up on new blocks since
// lastBlockScanned (unchanged forward-extension behavior), and — if the
// historyLookbackBlocks horizon hasn't been reached yet — also walks the
// scanned window backward by one historyBackfillStepBlocks step. Repeated
// calls (the app already polls every liveReadPollingIntervalMs) make
// steady backward progress until the full horizon is covered, at which
// point only forward extension continues, matching the original
// steady-state behavior exactly.
//
// This changes *when* a given block range gets scanned, never *what* gets
// returned for a range once scanned: every event is still read from a
// real eth_getLogs call, deduped by id, and merged via the same
// mergeAndSort() as before. Sums computed over the returned entries
// (reward-service.ts, staking-rewards-provider.ts) are exact for whatever
// has been scanned so far and converge to the exact full-history total as
// backfill completes — they are never wrong, only progressively more
// complete, which is the unavoidable consequence of Alchemy Free tier's
// 10-block eth_getLogs cap making a synchronous full-window scan
// impractical (see staking-config.ts's historyChunkSize/
// historyInitialWindowBlocks comments for the throughput math).
//
// Phase 3H — completeness-aware boundaries (correctness fix). scanAndCache
// no longer trusts that a fetchHistory() call succeeded just because it
// didn't throw. stakingHistoryReader.fetchHistory() now returns
// { events, complete }; scanAndCache merges `events` unconditionally
// (safe — mergeAndSort dedupes by id, so re-scanning an overlapping range
// on a retry can never double-count), but only advances
// lastBlockScanned/earliestBlockScanned when `complete` is true. A 429 or
// any other exhausted-retries failure can therefore never cause a block
// range to be permanently recorded as scanned — the unchanged boundary
// means the exact same range is recomputed and retried on the next call
// (forward: next poll; backfill: next poll's backfill step) until it
// succeeds. See scanAndCache below for where each of the three call
// sites (initial window, forward, backfill step) applies this.

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

// The actual scan-and-cache work, memoized per wallet in inFlightScans.
// Returns the full merged (unsliced) history so far — callers in
// getHistory() apply their own `limit` afterward. Never throws: on
// failure it logs and falls back to whatever was cached before this call
// started.
//
// Phase 3G strategy (see file header): a cache miss triggers only a small
// initial-window scan, not the full historyLookbackBlocks range. Once a
// cache entry exists, each call both catches up forward (new blocks since
// lastBlockScanned) and — if the full horizon isn't covered yet — steps
// the window backward by historyBackfillStepBlocks. earliestBlockScanned
// tracks how far back backfill has reached; once it's at or past the
// horizon floor, backward stepping stops and only forward catch-up runs,
// identical to the original steady-state behavior.
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
    const horizonFloor = latestBlock > lookback ? latestBlock - lookback : 0n;

    // --- Cache miss: scan only a small initial window, not the full
    // horizon. See staking-config.ts's historyInitialWindowBlocks comment
    // for why a full-window synchronous scan isn't practical on Alchemy
    // Free tier.
    if (!cached) {
      const initialWindow = BigInt(MPGR_STAKING_CONFIG.historyInitialWindowBlocks);
      const windowFrom = latestBlock > initialWindow ? latestBlock - initialWindow : 0n;
      const windowFloor = windowFrom > horizonFloor ? windowFrom : horizonFloor;

      // TEMPORARY — Phase 3F diagnostic trace only.
      const fetchStarted = trace.start("staking-history-reader.fetchHistory (initial window)", {
        fromBlock: windowFloor.toString(),
        toBlock: latestBlock.toString(),
      });
      const { events: initialEvents, complete: initialComplete } = await stakingHistoryReader.fetchHistory(
        walletAddress,
        windowFloor,
        latestBlock
      );
      trace.end("staking-history-reader.fetchHistory (initial window)", fetchStarted, {
        newEventsCount: initialEvents.length,
        complete: initialComplete,
      });

      const merged = mergeAndSort([], initialEvents);

      // Phase 3H — only persist a cache entry (and its scan boundaries)
      // if the initial window was fully scanned. If any chunk or
      // timestamp lookup failed after retries, leave historyCache unset:
      // the next call (this wallet has no cache entry yet either way)
      // will see a cache miss again and retry this same bounded window —
      // cheap (historyInitialWindowBlocks is small) and safe, since no
      // boundary was ever falsely marked as scanned. The events gathered
      // this attempt are still returned below for immediate display.
      if (initialComplete) {
        historyCache.set(cacheKey, {
          entries: merged,
          timestamp: Date.now(),
          ttl: MPGR_STAKING_CONFIG.historyCacheTtl,
          lastBlockScanned: latestBlock,
          earliestBlockScanned: windowFloor,
        });
      } else {
        logger.error("stakingHistoryService.getHistory initial window scan incomplete, will retry on next call", {
          walletAddress,
          windowFloor: windowFloor.toString(),
          latestBlock: latestBlock.toString(),
        });
      }

      if (merged.length > 0) {
        logger.debug("stakingHistoryService.getHistory found staking events (initial window)", {
          walletAddress,
          count: merged.length,
        });
      }

      // TEMPORARY — Phase 3F diagnostic trace only.
      trace.end("staking-history-service.scanAndCache", scanAndCacheStarted, {
        mergedCount: merged.length,
        initialWindow: true,
        complete: initialComplete,
        backfillComplete: initialComplete && windowFloor <= horizonFloor,
      });
      return merged;
    }

    // --- Forward catch-up: unchanged behavior — pick up anything new
    // since the last scan. Phase 3H: lastBlockScanned only advances if
    // the full forward range was confirmed scanned.
    let entries = cached.entries;
    let lastBlockScanned = cached.lastBlockScanned;
    if (lastBlockScanned < latestBlock) {
      // TEMPORARY — Phase 3F diagnostic trace only.
      const forwardStarted = trace.start("staking-history-reader.fetchHistory (forward)", {
        fromBlock: (lastBlockScanned + 1n).toString(),
        toBlock: latestBlock.toString(),
      });
      const { events: forwardEvents, complete: forwardComplete } = await stakingHistoryReader.fetchHistory(
        walletAddress,
        lastBlockScanned + 1n,
        latestBlock
      );
      trace.end("staking-history-reader.fetchHistory (forward)", forwardStarted, {
        newEventsCount: forwardEvents.length,
        complete: forwardComplete,
      });
      // Events found are real and safe to keep regardless of completeness
      // — mergeAndSort dedupes by id, so re-scanning this same range on a
      // future retry can never double-count them.
      entries = mergeAndSort(entries, forwardEvents);
      if (forwardComplete) {
        lastBlockScanned = latestBlock;
      } else {
        logger.error("stakingHistoryService.getHistory forward scan incomplete, will retry the same range next call", {
          walletAddress,
          fromBlock: (lastBlockScanned + 1n).toString(),
          toBlock: latestBlock.toString(),
        });
        // lastBlockScanned intentionally left at its previous value — the
        // next call recomputes [lastBlockScanned+1, newLatestBlock],
        // which is a superset of this failed range, so it gets retried
        // automatically without any special-casing.
      }
    }

    // --- Backward backfill step: only runs while the full horizon
    // hasn't been reached yet. Bounded by historyBackfillStepBlocks so no
    // single call reintroduces the full-window cost this strategy avoids.
    // Phase 3H: earliestBlockScanned only advances if this step was
    // confirmed fully scanned.
    let earliestBlockScanned = cached.earliestBlockScanned;
    if (earliestBlockScanned > horizonFloor) {
      const step = BigInt(MPGR_STAKING_CONFIG.historyBackfillStepBlocks);
      const stepFrom = earliestBlockScanned - step > horizonFloor ? earliestBlockScanned - step : horizonFloor;
      const stepTo = earliestBlockScanned - 1n;

      if (stepFrom <= stepTo) {
        // TEMPORARY — Phase 3F diagnostic trace only.
        const backfillStarted = trace.start("staking-history-reader.fetchHistory (backfill step)", {
          fromBlock: stepFrom.toString(),
          toBlock: stepTo.toString(),
        });
        const { events: backfillEvents, complete: backfillComplete } = await stakingHistoryReader.fetchHistory(
          walletAddress,
          stepFrom,
          stepTo
        );
        trace.end("staking-history-reader.fetchHistory (backfill step)", backfillStarted, {
          newEventsCount: backfillEvents.length,
          complete: backfillComplete,
        });
        entries = mergeAndSort(entries, backfillEvents);
        if (backfillComplete) {
          earliestBlockScanned = stepFrom;
        } else {
          logger.error("stakingHistoryService.getHistory backfill step incomplete, will retry the same step next call", {
            walletAddress,
            fromBlock: stepFrom.toString(),
            toBlock: stepTo.toString(),
          });
          // earliestBlockScanned intentionally left unchanged — the next
          // backfill cycle recomputes this exact same [stepFrom, stepTo]
          // step from the unchanged earliestBlockScanned and retries it.
        }
      }
    }

    historyCache.set(cacheKey, {
      entries,
      timestamp: Date.now(),
      ttl: MPGR_STAKING_CONFIG.historyCacheTtl,
      lastBlockScanned,
      earliestBlockScanned,
    });

    if (entries.length > cached.entries.length) {
      logger.debug("stakingHistoryService.getHistory found new staking events", {
        walletAddress,
        newCount: entries.length - cached.entries.length,
      });
    }

    // TEMPORARY — Phase 3F diagnostic trace only.
    trace.end("staking-history-service.scanAndCache", scanAndCacheStarted, {
      mergedCount: entries.length,
      backfillComplete: earliestBlockScanned <= horizonFloor,
    });
    return entries;
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
