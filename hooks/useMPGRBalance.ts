// hooks/useMPGRBalance.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { balanceService } from "@/lib/token/balance-service";
import { refreshManager } from "@/lib/token/refresh-manager";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";
import type { TokenBalance } from "@/lib/token/token-types";

// Phase 3E Part 1 — useMPGRBalance Hook.
//
// Manages live MPGR balance state for the connected wallet. Loads on mount,
// listens for balance_updated events from the event bus, and provides
// manual/automatic refresh methods. Never blocks the UI — all updates
// are background tasks or async operations.

interface UseMPGRBalanceReturn {
  raw: bigint | null;
  formatted: string;
  abbreviated: string;
  isLoading: boolean;
  error: string | null;
  lastUpdated: string | null;
  refresh: () => Promise<void>;
  isRefreshing: boolean;
}

export function useMPGRBalance(): UseMPGRBalanceReturn {
  const { address, isConnected } = useAccount();
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [abbreviated, setAbbreviated] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // Load balance on wallet connection or address change.
  useEffect(() => {
    if (!isConnected || !address) {
      setBalance(null);
      setAbbreviated("");
      setIsLoading(false);
      setError(null);
      setLastUpdated(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        const raw = await balanceService.getRawBalance(address);
        const formatted = await balanceService.getFormattedBalance(address);
        const abbr = await balanceService.getAbbreviatedBalance(address);

        setBalance({
          raw,
          formatted,
          decimal: MPGR_TOKEN_CONFIG.decimals,
        });
        setAbbreviated(abbr);
        setLastUpdated(new Date().toISOString());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load balance");
      } finally {
        setIsLoading(false);
      }
    })();
  }, [address, isConnected]);

  // Listen for balance updates from the event bus (fired by refresh-manager).
  useEffect(() => {
    const unsubscribe = agentEventBus.on("balance_updated", async (payload) => {
      if (payload.address !== address) return;
      setBalance(payload.balance);
      setLastUpdated(new Date().toISOString());
      setError(null);
      // Also update abbreviated version.
      const abbr = await balanceService.getAbbreviatedBalance(address);
      setAbbreviated(abbr);
    });
    return unsubscribe;
  }, [address]);

  // Manual refresh method.
  const refresh = useCallback(async () => {
    if (!address) return;
    setIsRefreshing(true);
    try {
      await refreshManager.refreshBalance(address);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }, [address]);

  return {
    raw: balance?.raw ?? null,
    formatted: balance?.formatted ?? "0",
    abbreviated,
    isLoading,
    error,
    lastUpdated,
    refresh,
    isRefreshing,
  };
}
