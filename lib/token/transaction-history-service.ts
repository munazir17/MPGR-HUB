// lib/token/transaction-history-service.ts

import type { Address } from "viem";
import { transferEventReader } from "./transfer-event-reader";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { agentTaskQueue } from "@/lib/architecture/core/task-queue";
import { logger } from "@/lib/architecture/core/logger";
import { agentPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";
import { MPGR_TOKEN_CONFIG } from "./token-config";
import type { TokenTransferEvent, TransactionHistoryCacheEntry } from "./token-types";

// Phase 3E Part 2 — Transaction History Service.
//
// Sits on top of transfer-event-reader.ts exactly the way
// balance-service.ts sits on top of token-client.ts: owns caching,
// incremental scanning (only asks the reader for blocks it hasn't seen
// yet), dedup across scans, and — new for this phase — event-bus
// emission, so any number of UI subscribers (an activity timeline, a
// toast on incoming transfer, a portfolio widget) can react without
// polling this service directly.

const historyCache = new Map<string, TransactionHistoryCacheEntry>();

function getCacheKey(walletAddress: Address): string {
  return `history:${walletAddress.toLowerCase()}`;
}

function isCacheValid(entry: TransactionHistoryCacheEntry): boolean {
  return Date.now() - entry.timestamp < entry.ttl;
}

// Merges freshly-scanned events into the existing cached list, dedupes by
// txHash+logIndex, and sorts newest-first (the order every consumer of
// this service expects — the reader itself returns oldest-first, which
// is the natural order for a forward block-range scan).
function mergeAndSort(existing: TokenTransferEvent[], incoming: TokenTransferEvent[]): TokenTransferEvent[] {
  const byKey = new Map<string, TokenTransferEvent>();
  for (const event of [...existing, ...incoming]) {
    byKey.set(`${event.txHash}:${event.logIndex}`, event);
  }
  return [...byKey.values()].sort((a, b) =>
    a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0
  );
}

export const transactionHistoryService = {
  // Returns the wallet's transfer history, newest-first, refreshing from
  // chain only for the block range it hasn't scanned yet. Pass
  // forceRefresh to ignore the cache TTL and re-check for new blocks
  // regardless of how recently this ran (used by manual refresh and the
  // background sync scheduler). Never throws — degrades to cached (even
  // stale) data on RPC failure, or an empty list if nothing is cached.
  async getHistory(
    walletAddress: Address,
    options: { forceRefresh?: boolean; limit?: number } = {}
  ): Promise<TokenTransferEvent[]> {
    const cacheKey = getCacheKey(walletAddress);
    const cached = historyCache.get(cacheKey);
    const limit = options.limit ?? MPGR_TOKEN_CONFIG.transactionHistoryPageSize;

    if (cached && !options.forceRefresh && isCacheValid(cached)) {
      return cached.entries.slice(0, limit);
    }

    return agentPerformanceMonitor.time("transactionHistoryService.getHistory", async () => {
      try {
        const latestBlock = await transferEventReader.getLatestBlockNumber();
        const lookback = BigInt(MPGR_TOKEN_CONFIG.transferLogLookbackBlocks);
        const defaultFromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;

        // Incremental scan: if this wallet has been scanned before, only
        // fetch the blocks since then. Otherwise scan the full lookback
        // window from scratch.
        const fromBlock = cached ? cached.lastBlockScanned + 1n : defaultFromBlock;

        if (cached && fromBlock > latestBlock) {
          // Nothing new to scan — the cache is only stale by TTL, not by
          // block height. Refresh the timestamp so callers stop
          // force-refreshing on every call.
          historyCache.set(cacheKey, { ...cached, timestamp: Date.now() });
          return cached.entries.slice(0, limit);
        }

        const newEvents = await transferEventReader.fetchTransfers(walletAddress, fromBlock, latestBlock);
        const merged = mergeAndSort(cached?.entries ?? [], newEvents);

        historyCache.set(cacheKey, {
          entries: merged,
          timestamp: Date.now(),
          ttl: MPGR_TOKEN_CONFIG.transactionHistoryCacheTtl,
          lastBlockScanned: latestBlock,
        });

        if (newEvents.length > 0) {
          logger.debug("transactionHistoryService.getHistory found new transfers", {
            walletAddress,
            newCount: newEvents.length,
          });

          for (const event of newEvents) {
            agentEventBus.emit("transfer_detected", {
              address: walletAddress,
              direction: event.direction,
              counterpartyAddress: event.direction === "in" ? event.from : event.to,
              amount: event.amount,
              txHash: event.txHash,
              blockNumber: event.blockNumber,
            });
          }

          agentEventBus.emit("transaction_history_updated", {
            address: walletAddress,
            totalCount: merged.length,
            newCount: newEvents.length,
            latestTimestamp: merged[0]?.timestamp ?? null,
          });
        }

        return merged.slice(0, limit);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("transactionHistoryService.getHistory failed", { walletAddress, error: errorMsg });
        // Graceful degradation: return whatever's cached (even if stale)
        // rather than surfacing an empty timeline on a transient RPC blip.
        return cached ? cached.entries.slice(0, limit) : [];
      }
    });
  },

  // Enqueues a background history refresh via the shared task queue —
  // mirrors refreshManager.enqueueBalanceRefresh's shape so callers reach
  // for the same pattern for either kind of background work.
  enqueueHistoryRefresh(walletAddress: Address): string {
    return agentTaskQueue.enqueue(
      `token.refreshHistory:${walletAddress}`,
      () => this.getHistory(walletAddress, { forceRefresh: true }),
      "low"
    );
  },

  // Returns cached history if valid, otherwise null (caller decides
  // whether to trigger a fetch). Useful for "show stale data while
  // refreshing" and for pagination bookkeeping (see hasMore in
  // hooks/useMPGRTransactionHistory.ts).
  getCachedHistory(walletAddress: Address): TokenTransferEvent[] | null {
    const cached = historyCache.get(getCacheKey(walletAddress));
    return cached && isCacheValid(cached) ? cached.entries : null;
  },

  // Manually clear cache for a single wallet (useful after a confirmed
  // send/receive, mirroring balanceService.clearCache's role).
  clearCache(walletAddress: Address): void {
    historyCache.delete(getCacheKey(walletAddress));
  },

  // Manually clear ALL history cache (rarely needed, but useful for
  // tests or if cache becomes corrupted).
  clearAllCache(): void {
    historyCache.clear();
  },
} as const;
