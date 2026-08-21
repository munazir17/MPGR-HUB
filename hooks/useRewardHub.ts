// hooks/useRewardHub.ts

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { rewardService } from "@/lib/rewards/reward-service";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { MPGR_REWARDS_CONFIG } from "@/lib/rewards/reward-config";
import type { RewardClaimHistoryEntry, RewardHubSummary } from "@/lib/rewards/reward-types";

// Phase 3F Part 1 — useRewardHub Hook.
//
// Mirrors hooks/useStaking.ts's shape: loads on mount/address change,
// polls at MPGR_REWARDS_CONFIG.liveReadPollingIntervalMs, and refreshes
// immediately off the "staking_changed" event.
//
// Reward Vault cleanup — this hook used to also expose claimLocalReward/
// claimAllLocalRewards, which called lib/rewards-engine.ts's local mock
// claimReward()/claimAllRewards() and emitted "rewards_claimed" to
// trigger a refresh. Neither function was ever wired to a button
// anywhere in the app, and real MPGR reward claiming now happens
// on-chain via hooks/useRewardClaim.ts (a separate, self-contained hook
// that doesn't read from or write into this one). Both functions, their
// claimingId/claimingAll state, and the now-permanently-dead
// "rewards_claimed" listener have been removed as unused code left over
// from that removal. This hook is read-only.
//
// Phase 3I — Reward Hub loading fix (decoupled Summary/History loading).
//
// This hook used to have ONE shared loading flag (`loading: !hasLoaded`),
// which only became true once BOTH rewardService.getRewardHubSummary()
// AND rewardService.getRewardHistory() resolved, via a single
// Promise.all() inside one load() function. app/rewards/page.tsx then
// passed that same flag to RewardHubSummaryCards, RewardCategoryGrid, AND
// RewardClaimHistoryList — so a slow claim-history load (behind
// lib/staking/staking-history-service.ts's chunked eth_getLogs scan, see
// staking-config.ts's historyInitialWindowBlocks/historyChunkSize
// comments for why a cold scan can take several seconds even on a
// healthy RPC) kept the Summary cards and Category grid skeletons on
// screen too, even though neither actually depends on that scan
// (see lib/rewards/providers/staking-rewards-provider.ts's getSummary()
// for the matching fix on the data side).
//
// Summary and History are now two fully independent load cycles —
// loadSummary() and loadHistory() below — each with its own in-flight
// guard, its own "has this loaded at least once" flag, and its own error
// state. Neither awaits the other. A slow or failing history load can
// never hold back the Summary/Category render, and vice versa; each
// path's own try/catch/finally guarantees its own loading flag can never
// get stuck at true, whether it succeeds, fails, or the request times out
// (lib/wagmi.ts's transport now has a bounded 10s timeout on every RPC
// call for exactly this reason).
//
// Phase 3F perf fix — loadingRef below (now split into two refs, one per
// load path, for the same reason):
// stakingHistoryService's inFlightScans already dedupes the history scan
// itself, but nothing previously stopped a second load() (from the
// liveReadPollingIntervalMs timer, or a staking_changed event) from
// re-running the WHOLE aggregation while an earlier load() for the same
// address was still in flight — including a fresh
// stakingService.getWalletState() RPC call, which has no in-flight dedup
// of its own. Measured trace evidence during diagnosis showed exactly
// this: a polling load firing while the initial cold-load scan was still
// running, adding extra concurrent RPC load on top of an already
// rate-limited endpoint. summaryLoadingRef/historyLoadingRef are simple
// per-address in-flight guards: if a load for this hook instance and
// path is already running, a second call for that same path defers to
// the running one instead of duplicating that work. It resolves once the
// in-flight load finishes and its result lands in state as normal.

interface UseRewardHubReturn {
  summary: RewardHubSummary | null;
  history: RewardClaimHistoryEntry[];
  summaryLoading: boolean;
  historyLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  summaryError: string | null;
  historyError: string | null;
  hasMoreHistory: boolean;
  refresh: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
}

export function useRewardHub(): UseRewardHubReturn {
  const { address, isConnected } = useAccount();

  const [summary, setSummary] = useState<RewardHubSummary | null>(null);
  const [history, setHistory] = useState<RewardClaimHistoryEntry[]>([]);
  const [historyPageSize, setHistoryPageSize] = useState<number>(
    MPGR_REWARDS_CONFIG.historyPageSize
  );
  const [hasLoadedSummary, setHasLoadedSummary] = useState(false);
  const [hasLoadedHistory, setHasLoadedHistory] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Phase 3I — one in-flight guard per independent load path. See the
  // Phase 3F perf-fix comment above the imports for why this exists.
  const summaryLoadingRef = useRef(false);
  const historyLoadingRef = useRef(false);

  const loadSummary = useCallback(
    async (forceRefresh: boolean) => {
      if (!address) return;

      // A summary load for this address is already running; skip this
      // call rather than re-running getWalletState() on top of it. The
      // in-flight load will update state when it resolves.
      if (summaryLoadingRef.current) {
        return;
      }
      summaryLoadingRef.current = true;

      try {
        const result = await rewardService.getRewardHubSummary(address, {
          forceRefresh,
        });
        setSummary(result);
        setSummaryError(null);
      } catch (err) {
        setSummaryError(
          err instanceof Error
            ? err.message
            : "Failed to load reward summary."
        );
      } finally {
        summaryLoadingRef.current = false;
      }
    },
    [address]
  );

  const loadHistory = useCallback(
    async (limit: number, forceRefresh: boolean) => {
      if (!address) return;

      // A history load for this address is already running (this defers
      // to it rather than starting a second one; the underlying scan
      // itself is separately deduped by stakingHistoryService's own
      // inFlightScans regardless).
      if (historyLoadingRef.current) {
        return;
      }
      historyLoadingRef.current = true;

      try {
        const result = await rewardService.getRewardHistory(address, {
          limit,
          forceRefresh,
        });
        setHistory(result);
        setHistoryError(null);

        // Phase 3J — Reward Hub loading fix, hole #1. Once history
        // finishes loading and its cache is populated, immediately
        // re-derive the summary from that now-populated cache instead of
        // leaving claimedRaw waiting for the next
        // MPGR_REWARDS_CONFIG.liveReadPollingIntervalMs poll (up to 15s
        // later) to pick it up. This calls the same loadSummary() as
        // every other refresh path (poll, staking_changed, manual
        // refresh) — its own in-flight guard applies as normal, and by
        // this point hasLoadedSummary is already true on every call site
        // that matters (the initial mount's own loadSummary() resolves
        // independently, in parallel with this), so this can never flip
        // summaryLoading back to true or block the UI — it's a quiet
        // background update, identical in kind to the existing polling
        // refresh, just triggered earlier.
        void loadSummary(true);
      } catch (err) {
        setHistoryError(
          err instanceof Error
            ? err.message
            : "Failed to load claim history."
        );
      } finally {
        historyLoadingRef.current = false;
      }
    },
    [address, loadSummary]
  );

  useEffect(() => {
    if (!isConnected || !address) {
      setSummary(null);
      setHistory([]);
      setSummaryError(null);
      setHistoryError(null);
      setHasLoadedSummary(false);
      setHasLoadedHistory(false);
      setHistoryPageSize(MPGR_REWARDS_CONFIG.historyPageSize);
      return;
    }

    setHistoryPageSize(MPGR_REWARDS_CONFIG.historyPageSize);

    // Independent — neither awaits the other, so a slow/cold history scan
    // can never delay the summary render, and a slow summary read can
    // never delay history loading.
    loadSummary(false).finally(() => setHasLoadedSummary(true));
    loadHistory(MPGR_REWARDS_CONFIG.historyPageSize, false).finally(() =>
      setHasLoadedHistory(true)
    );
  }, [address, isConnected, loadSummary, loadHistory]);

  useEffect(() => {
    if (!isConnected || !address) return;

    const id = setInterval(() => {
      loadSummary(true);
      loadHistory(historyPageSize, true);
    }, MPGR_REWARDS_CONFIG.liveReadPollingIntervalMs);

    return () => clearInterval(id);
  }, [address, isConnected, historyPageSize, loadSummary, loadHistory]);

  useEffect(() => {
    const unsubscribeStaking = agentEventBus.on(
      "staking_changed",
      (payload) => {
        if (!address || payload.address !== address) return;

        rewardService.clearCache(address);

        void loadSummary(true);
        void loadHistory(historyPageSize, true);
      }
    );

    return () => {
      unsubscribeStaking();
    };
  }, [address, historyPageSize, loadSummary, loadHistory]);

  const refresh = useCallback(async () => {
    if (!address) return;

    setIsRefreshing(true);
    rewardService.clearCache(address);

    try {
      await Promise.all([
        loadSummary(true),
        loadHistory(historyPageSize, true),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [address, historyPageSize, loadSummary, loadHistory]);

  const loadMoreHistory = useCallback(async () => {
    if (!address) return;

    const nextPageSize =
      historyPageSize + MPGR_REWARDS_CONFIG.historyPageSize;

    setIsLoadingMore(true);

    try {
      const entries = await rewardService.getRewardHistory(address, {
        limit: nextPageSize,
      });

      setHistory(entries);
      setHistoryPageSize(nextPageSize);
    } finally {
      setIsLoadingMore(false);
    }
  }, [address, historyPageSize]);

  const cachedHistory = address
    ? rewardService.getCachedRewardHistory(address)
    : null;

  const hasMoreHistory = cachedHistory
    ? cachedHistory.length > history.length
    : history.length >= historyPageSize;

  return {
    summary,
    history,
    summaryLoading: isConnected ? !hasLoadedSummary : !summary,
    historyLoading: isConnected ? !hasLoadedHistory : history.length === 0,
    isRefreshing,
    isLoadingMore,
    summaryError,
    historyError,
    hasMoreHistory,
    refresh,
    loadMoreHistory,
  };
}
