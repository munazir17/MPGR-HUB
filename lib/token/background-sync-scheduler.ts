// lib/token/background-sync-scheduler.ts

import type { Address } from "viem";
import { portfolioSyncService } from "./portfolio-sync-service";
import { agentTaskQueue } from "@/lib/architecture/core/task-queue";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { logger } from "@/lib/architecture/core/logger";
import { MPGR_TOKEN_CONFIG } from "./token-config";
import type { SyncStatus, SyncStrategyKind } from "./token-types";

// Phase 3E Part 2 — Background Sync Scheduler.
//
// Owns the "keep this wallet's portfolio fresh without anyone asking"
// loop. One active schedule per wallet address, started/stopped
// explicitly (hooks/useMPGRPortfolioSync.ts starts it on wallet connect,
// stops it on disconnect/unmount) — this module never starts anything on
// its own.
//
// Every tick's actual work (portfolioSyncService.syncNow) runs through
// the shared task queue rather than being invoked directly from the
// timer callback, so a slow sync round can never overlap with the next
// tick or block anything else the queue is processing.
//
// Uses recursive setTimeout rather than setInterval: the delay between
// ticks changes (exponential backoff on repeated failures, reset on
// success), and setTimeout lets that delay change per-tick without
// tearing down and recreating a running interval, and without risking
// overlapping ticks if a sync round runs long.
//
// Strategy abstraction: today the only implementation is polling,
// because lib/wagmi.ts's transport is http(). SyncStrategyKind and
// getActiveStrategyKind() exist so a future webSocket() transport can
// flip this module (and only this module) over to a push-based strategy
// without any caller — useMPGRPortfolioSync, or code reading
// getStatus()/getAllStatuses() — needing to change; they already treat
// the strategy as an opaque label.

interface ScheduledSync {
  timeoutId: ReturnType<typeof setTimeout>;
  status: SyncStatus;
}

const activeSyncs = new Map<string, ScheduledSync>();

function getKey(walletAddress: Address): string {
  return walletAddress.toLowerCase();
}

// Base's transport is http() today (see lib/wagmi.ts); this always
// resolves to "polling" until a webSocket() transport is introduced.
// Kept as a function (not a constant) so that future change only means
// updating this one check.
function getActiveStrategyKind(): SyncStrategyKind {
  return "polling";
}

// Exponential backoff for repeated failures, capped at
// backgroundSyncMaxIntervalMs — a wallet whose RPC calls keep failing
// backs off automatically instead of hammering a struggling endpoint at
// a fixed cadence regardless of outcome.
function computeNextIntervalMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return MPGR_TOKEN_CONFIG.backgroundSyncIntervalMs;
  const backoff = MPGR_TOKEN_CONFIG.backgroundSyncIntervalMs * 2 ** consecutiveFailures;
  return Math.min(backoff, MPGR_TOKEN_CONFIG.backgroundSyncMaxIntervalMs);
}

// Runs one sync round through the task queue, then reschedules itself.
function runTick(walletAddress: Address): void {
  const key = getKey(walletAddress);

  agentTaskQueue.enqueue(
    `token.backgroundSync:${key}`,
    async () => {
      const scheduled = activeSyncs.get(key);
      if (!scheduled) return; // stopped before this queued tick ran

      const result = await portfolioSyncService.syncNow(walletAddress, "poll");

      const stillActive = activeSyncs.get(key);
      if (!stillActive) return; // stopped while syncNow was in flight

      if (result.success) {
        stillActive.status.consecutiveFailures = 0;
      } else {
        stillActive.status.consecutiveFailures += 1;
        agentEventBus.emit("sync_error", {
          address: walletAddress,
          message: "Background portfolio sync did not fully succeed",
          consecutiveFailures: stillActive.status.consecutiveFailures,
        });
      }
      stillActive.status.lastSyncedAt = new Date().toISOString();

      const nextDelay = computeNextIntervalMs(stillActive.status.consecutiveFailures);
      stillActive.status.nextRetryDelayMs = nextDelay;
      stillActive.timeoutId = setTimeout(() => runTick(walletAddress), nextDelay);
    },
    "low"
  );
}

export const backgroundSyncScheduler = {
  // Starts (or restarts, if already running) background sync for a
  // wallet. Fires an immediate sync through the task queue so the UI
  // doesn't wait a full interval for its first live update, then
  // continues on the configured cadence.
  start(walletAddress: Address): void {
    if (typeof window === "undefined") {
      logger.debug("backgroundSyncScheduler.start skipped (no window)", { walletAddress });
      return;
    }

    this.stop(walletAddress);

    const key = getKey(walletAddress);
    const strategy = getActiveStrategyKind();
    const initialDelay = MPGR_TOKEN_CONFIG.backgroundSyncIntervalMs;

    activeSyncs.set(key, {
      timeoutId: setTimeout(() => runTick(walletAddress), initialDelay),
      status: {
        isActive: true,
        strategy,
        lastSyncedAt: null,
        consecutiveFailures: 0,
        nextRetryDelayMs: initialDelay,
      },
    });

    agentEventBus.emit("sync_started", { address: walletAddress, strategy, intervalMs: initialDelay });

    // Immediate first sync so the UI has live data right away instead of
    // waiting a full interval — runs through the queue like every other
    // tick, it's just enqueued now instead of after a delay.
    agentTaskQueue.enqueue(
      `token.backgroundSync:initial:${key}`,
      () => portfolioSyncService.syncNow(walletAddress, "poll"),
      "low"
    );
  },

  // Stops background sync for a wallet. Safe to call even if nothing is
  // currently scheduled for it.
  stop(walletAddress: Address): void {
    const key = getKey(walletAddress);
    const scheduled = activeSyncs.get(key);
    if (!scheduled) return;
    clearTimeout(scheduled.timeoutId);
    activeSyncs.delete(key);
    agentEventBus.emit("sync_stopped", { address: walletAddress });
  },

  // Stops every active background sync — useful on full app teardown or
  // for tests.
  stopAll(): void {
    for (const scheduled of activeSyncs.values()) clearTimeout(scheduled.timeoutId);
    activeSyncs.clear();
  },

  // Returns the current sync status for a wallet, or null if it has no
  // active background sync.
  getStatus(walletAddress: Address): SyncStatus | null {
    return activeSyncs.get(getKey(walletAddress))?.status ?? null;
  },

  // Diagnostics: every wallet currently under background sync, keyed by
  // lowercased address.
  getAllStatuses(): Record<string, SyncStatus> {
    const result: Record<string, SyncStatus> = {};
    for (const [key, scheduled] of activeSyncs) result[key] = scheduled.status;
    return result;
  },
} as const;
