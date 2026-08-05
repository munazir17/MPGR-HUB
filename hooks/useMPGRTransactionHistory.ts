// hooks/useMPGRTransactionHistory.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { transactionHistoryService } from "@/lib/token/transaction-history-service";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { MPGR_TOKEN_CONFIG } from "@/lib/token/token-config";
import type { TokenTransferEvent } from "@/lib/token/token-types";

// Phase 3E Part 2 — useMPGRTransactionHistory Hook.
//
// Wallet activity timeline for the connected address. Loads the first
// page on mount/address change, listens for transaction_history_updated
// so a background sync tick (or a detected live transfer) updates the
// list without the component needing to poll, and exposes loadMore for
// pagination beyond the initial page.

interface UseMPGRTransactionHistoryReturn {
  transfers: TokenTransferEvent[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

export function useMPGRTransactionHistory(): UseMPGRTransactionHistoryReturn {
  const { address, isConnected } = useAccount();
  const [transfers, setTransfers] = useState<TokenTransferEvent[]>([]);
  // Explicitly typed <number>: MPGR_TOKEN_CONFIG is declared `as const`,
  // so `transactionHistoryPageSize` has the literal type `20`, not
  // `number`. Without this annotation, useState's generic infers from
  // that literal (unlike a fresh literal such as `useState(false)`,
  // which widens to `boolean`, a literal read off a const-asserted
  // object does not widen), locking pageSize's state type to the
  // literal `20` and rejecting any other number passed to setPageSize.
  const [pageSize, setPageSize] = useState<number>(MPGR_TOKEN_CONFIG.transactionHistoryPageSize);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (limit: number, forceRefresh: boolean) => {
      if (!address) return;
      try {
        const result = await transactionHistoryService.getHistory(address, { limit, forceRefresh });
        setTransfers(result);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load transaction history");
      }
    },
    [address]
  );

  // Load first page on connect / address change.
  useEffect(() => {
    if (!isConnected || !address) {
      setTransfers([]);
      setError(null);
      setPageSize(MPGR_TOKEN_CONFIG.transactionHistoryPageSize);
      return;
    }

    setIsLoading(true);
    setPageSize(MPGR_TOKEN_CONFIG.transactionHistoryPageSize);
    load(MPGR_TOKEN_CONFIG.transactionHistoryPageSize, false).finally(() => setIsLoading(false));
  }, [address, isConnected, load]);

  // Live updates: a background sync tick, manual refresh elsewhere, or a
  // detected transfer all funnel through transaction_history_updated.
  useEffect(() => {
    const unsubscribe = agentEventBus.on("transaction_history_updated", (payload) => {
      if (!address || payload.address.toLowerCase() !== address.toLowerCase()) return;
      void load(pageSize, false);
    });
    return unsubscribe;
  }, [address, pageSize, load]);

  // Manual refresh — bypasses cache TTL to force a fresh chain check.
  const refresh = useCallback(async () => {
    if (!address) return;
    setIsRefreshing(true);
    try {
      await load(pageSize, true);
    } finally {
      setIsRefreshing(false);
    }
  }, [address, pageSize, load]);

  // Pagination — widens the requested page size and re-reads from cache
  // (cheap; transaction-history-service only hits the chain when the
  // cache is stale or the range is genuinely new).
  const loadMore = useCallback(async () => {
    if (!address) return;
    const nextPageSize = pageSize + MPGR_TOKEN_CONFIG.transactionHistoryPageSize;
    setIsLoading(true);
    try {
      await load(nextPageSize, false);
      setPageSize(nextPageSize);
    } finally {
      setIsLoading(false);
    }
  }, [address, pageSize, load]);

  const cachedAll = address ? transactionHistoryService.getCachedHistory(address) : null;
  const hasMore = cachedAll ? cachedAll.length > transfers.length : transfers.length >= pageSize;

  return { transfers, isLoading, isRefreshing, error, hasMore, refresh, loadMore };
}
