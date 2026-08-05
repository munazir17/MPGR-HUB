// lib/token/refresh-manager.ts

import { balanceService } from "./balance-service";
import { tokenService } from "./token-service";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { logger } from "@/lib/architecture/core/logger";
import { agentTaskQueue } from "@/lib/architecture/core/task-queue";
import type { Address } from "viem";
import type { TokenRefreshResult } from "./token-types";

// Phase 3E Part 1 — Refresh Manager.
//
// Coordinates balance and metadata refreshes, ensuring:
// 1. No duplicate RPC calls (debounced by address change)
// 2. No blocking the UI (runs in background via task queue)
// 3. Event emission for subscribers (AgentEventBus)
// 4. Logging for diagnostics (agentEventBus + logger)
// 5. Graceful degradation on RPC failures (never throws)

let lastRefreshTime = 0;
let lastRefreshAddress: Address | null = null;
const REFRESH_DEBOUNCE_MS = 1000; // Minimum 1s between refreshes for same address

export const refreshManager = {
  // Triggers a manual balance refresh for a wallet. Debounced to prevent
  // spam; if called multiple times within 1s for the same address, only
  // the last call actually hits the RPC.
  async refreshBalance(walletAddress: Address): Promise<TokenRefreshResult> {
    const start = Date.now();
    const now = Date.now();

    // Debounce: if we just refreshed this address, skip.
    if (
      lastRefreshAddress === walletAddress &&
      now - lastRefreshTime < REFRESH_DEBOUNCE_MS
    ) {
      logger.debug("refreshManager.refreshBalance skipped (debounced)", {
        walletAddress,
        timeSinceLastRefresh: now - lastRefreshTime,
      });
      return {
        success: false,
        error: "Refresh in progress",
        durationMs: 0,
        timestamp: new Date().toISOString(),
      };
    }

    lastRefreshTime = now;
    lastRefreshAddress = walletAddress;

    try {
      // Clear cache first so next fetch is fresh.
      balanceService.clearCache(walletAddress);
      const balance = await balanceService.getRawBalance(walletAddress);
      const durationMs = Date.now() - start;

      logger.debug("refreshManager.refreshBalance succeeded", {
        walletAddress,
        balance: balance.toString(),
        durationMs,
      });

      agentEventBus.emit("balance_updated", {
        address: walletAddress,
        balance: {
          raw: balance,
          formatted: balance.toString(),
          decimal: 18,
        },
      });

      return {
        success: true,
        balance: {
          raw: balance,
          formatted: balance.toString(),
          decimal: 18,
        },
        durationMs,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      logger.error("refreshManager.refreshBalance failed", {
        walletAddress,
        error: errorMsg,
        durationMs,
      });

      return {
        success: false,
        error: errorMsg,
        durationMs,
        timestamp: new Date().toISOString(),
      };
    }
  },

  // Triggers a background refresh using the task queue (never blocks the UI).
  // Returns a task id immediately; caller can poll the task queue to check status.
  enqueueBalanceRefresh(walletAddress: Address): string {
    return agentTaskQueue.enqueue(
      `token.refreshBalance:${walletAddress}`,
      () => this.refreshBalance(walletAddress),
      "normal"
    );
  },

  // Refreshes token metadata (name, symbol, decimals, totalSupply).
  // Cached for 1 hour, so this is fast on subsequent calls.
  async refreshMetadata(): Promise<TokenRefreshResult> {
    const start = Date.now();
    try {
      tokenService.clearCache();
      const metadata = await tokenService.getMetadata();
      const durationMs = Date.now() - start;

      logger.debug("refreshManager.refreshMetadata succeeded", {
        metadata,
        durationMs,
      });

      agentEventBus.emit("token_loaded", {
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
      });

      return {
        success: true,
        durationMs,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      logger.error("refreshManager.refreshMetadata failed", {
        error: errorMsg,
        durationMs,
      });

      return {
        success: false,
        error: errorMsg,
        durationMs,
        timestamp: new Date().toISOString(),
      };
    }
  },

  // Enqueues metadata refresh as a background task.
  enqueueMetadataRefresh(): string {
    return agentTaskQueue.enqueue("token.refreshMetadata", () => this.refreshMetadata(), "low");
  },
} as const;
