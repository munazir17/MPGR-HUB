// lib/token/portfolio-sync-service.ts

import type { Address } from "viem";
import { refreshManager } from "./refresh-manager";
import { transactionHistoryService } from "./transaction-history-service";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { logger } from "@/lib/architecture/core/logger";
import { agentPerformanceMonitor } from "@/lib/architecture/core/performance-monitor";

// Phase 3E Part 2 — Portfolio Sync Service.
//
// "Live portfolio updates" means balance and transaction history staying
// in sync together, not two independent refresh cycles that can drift
// out of step with each other. This service is the single place that
// triggers both, so a caller — background-sync-scheduler.ts's tick, or a
// UI's manual "refresh" button — only ever has to call one function.
//
// Deliberately thin: all the actual RPC work, caching, and retry logic
// already live in refresh-manager.ts and transaction-history-service.ts.
// This module composes them and emits one event when a sync round
// completes, so subscribers don't need to listen to two separate event
// streams and reconcile them.

export type PortfolioSyncSource = "manual" | "poll" | "event";

export const portfolioSyncService = {
  // Runs a full sync round: balance + transaction history, concurrently.
  // Never throws — a failure in either half is logged and reflected in
  // the returned result, never left to bubble up and break a caller's
  // interval loop or a UI event handler.
  async syncNow(
    walletAddress: Address,
    source: PortfolioSyncSource = "manual"
  ): Promise<{ success: boolean; balanceOk: boolean; historyOk: boolean }> {
    return agentPerformanceMonitor.time("portfolioSyncService.syncNow", async () => {
      const [balanceResult, historyResult] = await Promise.allSettled([
        refreshManager.refreshBalance(walletAddress),
        transactionHistoryService.getHistory(walletAddress, { forceRefresh: true }),
      ]);

      const balanceOk = balanceResult.status === "fulfilled" && balanceResult.value.success;
      const historyOk = historyResult.status === "fulfilled";

      if (balanceResult.status === "rejected") {
        logger.error("portfolioSyncService.syncNow balance refresh rejected", {
          walletAddress,
          source,
          error: String(balanceResult.reason),
        });
      }
      if (historyResult.status === "rejected") {
        logger.error("portfolioSyncService.syncNow history refresh rejected", {
          walletAddress,
          source,
          error: String(historyResult.reason),
        });
      }

      agentEventBus.emit("portfolio_synced", {
        address: walletAddress,
        timestamp: new Date().toISOString(),
        source,
      });

      return { success: balanceOk && historyOk, balanceOk, historyOk };
    });
  },
} as const;
