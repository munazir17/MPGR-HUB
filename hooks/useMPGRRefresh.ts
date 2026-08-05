// hooks/useMPGRRefresh.ts

"use client";

import { useCallback, useState } from "react";
import { useAccount } from "wagmi";
import { refreshManager } from "@/lib/token/refresh-manager";

// Phase 3E Part 1 — useMPGRRefresh Hook.
//
// Provides methods to manually trigger balance and metadata refreshes.
// Useful for UI buttons, post-transaction updates, or periodic polling.

interface UseMPGRRefreshReturn {
  refreshBalance: () => Promise<void>;
  refreshMetadata: () => Promise<void>;
  refreshAll: () => Promise<void>;
  isRefreshing: boolean;
  error: string | null;
}

export function useMPGRRefresh(): UseMPGRRefreshReturn {
  const { address } = useAccount();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshBalance = useCallback(async () => {
    if (!address) return;
    setIsRefreshing(true);
    setError(null);
    try {
      await refreshManager.refreshBalance(address);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }, [address]);

  const refreshMetadata = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      await refreshManager.refreshMetadata();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      await Promise.all([
        address ? refreshManager.refreshBalance(address) : Promise.resolve(),
        refreshManager.refreshMetadata(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }, [address]);

  return { refreshBalance, refreshMetadata, refreshAll, isRefreshing, error };
}
