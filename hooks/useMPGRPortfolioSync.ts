// hooks/useMPGRPortfolioSync.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { backgroundSyncScheduler } from "@/lib/token/background-sync-scheduler";
import { portfolioSyncService } from "@/lib/token/portfolio-sync-service";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import type { SyncStatus } from "@/lib/token/token-types";

// Phase 3E Part 2 — useMPGRPortfolioSync Hook.
//
// Starts background sync for the connected wallet on mount, stops it on
// disconnect or unmount (so no timer keeps running for a wallet the user
// has navigated away from), and surfaces live sync status plus a manual
// "sync now" trigger for a UI refresh button.

interface UseMPGRPortfolioSyncReturn {
  status: SyncStatus | null;
  lastSyncedAt: string | null;
  isSyncing: boolean;
  syncNow: () => Promise<void>;
}

export function useMPGRPortfolioSync(): UseMPGRPortfolioSyncReturn {
  const { address, isConnected } = useAccount();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Start/stop the background scheduler in lockstep with connection state.
  useEffect(() => {
    if (!isConnected || !address) {
      setStatus(null);
      return;
    }

    backgroundSyncScheduler.start(address);
    setStatus(backgroundSyncScheduler.getStatus(address));

    return () => {
      backgroundSyncScheduler.stop(address);
    };
  }, [address, isConnected]);

  // Keep status fresh by re-reading it whenever a portfolio_synced or
  // sync_error event fires for this address — cheap, since getStatus()
  // just reads an in-memory map maintained by the scheduler.
  useEffect(() => {
    if (!address) return;

    const refreshStatus = () => setStatus(backgroundSyncScheduler.getStatus(address));
    const unsubscribeSynced = agentEventBus.on("portfolio_synced", (payload) => {
      if (payload.address.toLowerCase() === address.toLowerCase()) refreshStatus();
    });
    const unsubscribeError = agentEventBus.on("sync_error", (payload) => {
      if (payload.address.toLowerCase() === address.toLowerCase()) refreshStatus();
    });

    return () => {
      unsubscribeSynced();
      unsubscribeError();
    };
  }, [address]);

  // Manual sync trigger for a UI "refresh" button — runs through the
  // same portfolioSyncService the background loop uses, tagged "manual"
  // so subscribers can distinguish a user-initiated sync from a poll tick.
  const syncNow = useCallback(async () => {
    if (!address) return;
    setIsSyncing(true);
    try {
      await portfolioSyncService.syncNow(address, "manual");
      setStatus(backgroundSyncScheduler.getStatus(address));
    } finally {
      setIsSyncing(false);
    }
  }, [address]);

  return { status, lastSyncedAt: status?.lastSyncedAt ?? null, isSyncing, syncNow };
}
