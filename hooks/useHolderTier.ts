// hooks/useHolderTier.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import {
  HOLDER_TIERS,
  HOLDER_FEATURE_FLAGS,
  getHolderTierStatus,
  getHolderTierState,
  getHolderAchievements,
  claimHolderAchievement,
  getHolderFuturePerks,
  getHolderEvents,
  getHolderLeaderboardEntry,
  getHolderScoreFromBalances,
  type HolderTierStatus,
  type HolderTierState,
} from "@/lib/holder-tier-engine";
import { useMPGRBalance } from "@/hooks/useMPGRBalance";
import { useStaking } from "@/hooks/useStaking";
import { useTokenLock } from "@/hooks/useTokenLock";
import type { Achievement } from "@/lib/xp-engine";

export function useHolderTier() {
  const { address, isConnected } = useAccount();
  const { raw: walletRaw, isLoading: walletLoading, error: walletError } = useMPGRBalance();
  const {
    stakedBalanceRaw,
    decimals: stakingDecimals,
    loading: stakingLoading,
  } = useStaking();
  const { totalLocked, loading: lockLoading } = useTokenLock();
  const [status, setStatus] = useState<HolderTierStatus | null>(null);
  const [state, setState] = useState<HolderTierState | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const walletReady = !isConnected || (!walletLoading && (walletRaw !== null || !!walletError));
  const stakingReady = !isConnected || !stakingLoading;
  const lockReady = !isConnected || !lockLoading;
  const liveReady = walletReady && stakingReady && lockReady;

  const refresh = useCallback(() => {
    if (!address) return;
    if (!liveReady) return;
    const walletBalance = walletRaw != null ? parseFloat(formatUnits(walletRaw, stakingDecimals)) : 0;
    const stakedBalance = parseFloat(formatUnits(stakedBalanceRaw, stakingDecimals));
    const score = getHolderScoreFromBalances(walletBalance, stakedBalance, totalLocked);
    setStatus(getHolderTierStatus(address, score));
    setState(getHolderTierState(address));
  }, [address, liveReady, walletRaw, stakedBalanceRaw, stakingDecimals, totalLocked]);

  useEffect(() => {
    if (!isConnected || !address) {
      setStatus(null);
      setState(null);
      setHasLoaded(false);
      return;
    }
    // Wait for live wallet / staking / lock reads so we never flash a
    // placeholder Holder Score (the previous sync path settled on 100
    // from leftover mock lock data before on-chain caches populated).
    if (!liveReady) {
      setHasLoaded(false);
      setStatus(null);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh, liveReady]);

  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [address, isConnected, refresh]);

  const achievements: Achievement[] = status && state ? getHolderAchievements(status, state) : [];
  const futurePerks = status ? getHolderFuturePerks(status) : null;
  const events = status ? getHolderEvents(status) : [];
  const leaderboardEntry = address ? getHolderLeaderboardEntry(address, status) : null;

  const claimAchievement = useCallback(
    (achievementId: string) => {
      if (!address) return;
      setState(claimHolderAchievement(address, achievementId, status?.score));
    },
    [address, status]
  );

  return {
    tiers: HOLDER_TIERS,
    featureFlags: HOLDER_FEATURE_FLAGS,
    status,
    state,
    achievements,
    futurePerks,
    events,
    leaderboardEntry,
    isConnected,
    loading: isConnected && !hasLoaded,
    claimAchievement,
    refresh,
  };
}
