// hooks/useRewardHub.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { rewardService } from "@/lib/rewards/reward-service";
import { claimAllRewards, claimReward } from "@/lib/rewards-engine";
import { agentEventBus } from "@/lib/architecture/core/event-bus";
import { MPGR_REWARDS_CONFIG } from "@/lib/rewards/reward-config";
import type { RewardClaimHistoryEntry, RewardHubSummary } from "@/lib/rewards/reward-types";

// Phase 3F Part 1 — useRewardHub Hook.
//
// Mirrors hooks/useStaking.ts's shape: loads on mount/address change,
// polls at MPGR_REWARDS_CONFIG.liveReadPollingIntervalMs, and refreshes
// immediately off two events — the existing "staking_changed" (already
// emitted by refreshManager.refreshStaking after every confirmed staking
// action, see hooks/useStaking.ts) and the existing but previously unused
// "rewards_claimed" event (already declared in
// lib/architecture/core/types.ts), which this hook now emits itself after
// a local claim so any other part of the app listening for it stays in
// sync too.
//
// Claiming: this hook only submits LOCAL claims (daily/referral/season),
// via lib/rewards-engine.ts's existing claimReward()/claimAllRewards() —
// completely unchanged, same functions hooks/useRewards.ts already
// calls. It never submits a staking claim transaction; the "staking"
// category is read-only here by design (see
// lib/rewards/providers/staking-rewards-provider.ts) — claiming staking
// rewards continues to happen exclusively on the Staking page via
// hooks/useStaking.ts's claimRewards(), so there is exactly one place in
// the codebase that can submit that transaction.

interface UseRewardHubReturn {
  summary: RewardHubSummary | null;
  history: RewardClaimHistoryEntry[];
  loading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMoreHistory: boolean;
  claimingId: string | null;
  claimingAll: boolean;
  claimLocalReward: (rewardId: string) => Promise<void>;
  claimAllLocalRewards: () => Promise<void>;
  refresh: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
}

export function useRewardHub(): UseRewardHubReturn {
  const { address, isConnected } = useAccount();

  const [summary, setSummary] = useState<RewardHubSummary | null>(null);
  const [history, setHistory] = useState<RewardClaimHistoryEntry[]>([]);
  const [historyPageSize, setHistoryPageSize] = useState<number>(MPGR_REWARDS_CONFIG.historyPageSize);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimingAll, setClaimingAll] = useState(false);

  const load = useCallback(
    async (limit: number, forceRefresh: boolean) => {
      if (!address) return;
      try {
        const [summaryResult, historyResult] = await Promise.all([
          rewardService.getRewardHubSummary(address, { forceRefresh }),
          rewardService.getRewardHistory(address, { limit, forceRefresh }),
        ]);
        setSummary(summaryResult);
        setHistory(historyResult);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load reward data.");
      }
    },
    [address]
  );

  useEffect(() => {
    if (!isConnected || !address) {
      setSummary(null);
      setHistory([]);
      setError(null);
      setHasLoaded(false);
      setHistoryPageSize(MPGR_REWARDS_CONFIG.historyPageSize);
      return;
    }
    setHistoryPageSize(MPGR_REWARDS_CONFIG.historyPageSize);
    load(MPGR_REWARDS_CONFIG.historyPageSize, false).finally(() => setHasLoaded(true));
  }, [address, isConnected, load]);

  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(() => {
      load(historyPageSize, true);
    }, MPGR_REWARDS_CONFIG.liveReadPollingIntervalMs);
    return () => clearInterval(id);
  }, [address, isConnected, historyPageSize, load]);

  useEffect(() => {
    const unsubscribeStaking = agentEventBus.on("staking_changed", (payload) => {
      if (!address || payload.address !== address) return;
      rewardService.clearCache(address);
      void load(historyPageSize, true);
    });
    const unsubscribeRewards = agentEventBus.on("rewards_claimed", (payload) => {
      if (!address || payload.address !== address) return;
      rewardService.clearCache(address);
      void load(historyPageSize, true);
    });
    return () => {
      unsubscribeStaking();
      unsubscribeRewards();
    };
  }, [address, historyPageSize, load]);

  const refresh = useCallback(async () => {
    if (!address) return;
    setIsRefreshing(true);
    rewardService.clearCache(address);
    try {
      await load(historyPageSize, true);
    } finally {
      setIsRefreshing(false);
    }
  }, [address, historyPageSize, load]);

  const loadMoreHistory = useCallback(async () => {
    if (!address) return;
    const nextPageSize = historyPageSize + MPGR_REWARDS_CONFIG.historyPageSize;
    setIsLoadingMore(true);
    try {
      const entries = await rewardService.getRewardHistory(address, { limit: nextPageSize });
      setHistory(entries);
      setHistoryPageSize(nextPageSize);
    } finally {
      setIsLoadingMore(false);
    }
  }, [address, historyPageSize]);

  const claimLocalReward = useCallback(
    async (rewardId: string) => {
      if (!address || claimingId || claimingAll) return;
      setClaimingId(rewardId);
      try {
        const result = claimReward(address, rewardId);
        if (result.claimedAmount > 0) {
          agentEventBus.emit("rewards_claimed", { address, amount: result.claimedAmount });
        }
        rewardService.clearCache(address);
        await load(historyPageSize, true);
      } finally {
        setClaimingId(null);
      }
    },
    [address, claimingId, claimingAll, historyPageSize, load]
  );

  const claimAllLocalRewards = useCallback(async () => {
    if (!address || claimingId || claimingAll) return;
    setClaimingAll(true);
    try {
      const result = claimAllRewards(address);
      if (result.claimedAmount > 0) {
        agentEventBus.emit("rewards_claimed", { address, amount: result.claimedAmount });
      }
      rewardService.clearCache(address);
      await load(historyPageSize, true);
    } finally {
      setClaimingAll(false);
    }
  }, [address, claimingId, claimingAll, historyPageSize, load]);

  const cachedHistory = address ? rewardService.getCachedRewardHistory(address) : null;
  const hasMoreHistory = cachedHistory ? cachedHistory.length > history.length : history.length >= historyPageSize;

  return {
    summary,
    history,
    loading: isConnected ? !hasLoaded : !summary,
    isRefreshing,
    isLoadingMore,
    error,
    hasMoreHistory,
    claimingId,
    claimingAll,
    claimLocalReward,
    claimAllLocalRewards,
    refresh,
    loadMoreHistory,
  };
}
