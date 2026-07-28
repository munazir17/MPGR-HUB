// hooks/useHolderTier.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
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
  type HolderTierStatus,
  type HolderTierState,
} from "@/lib/holder-tier-engine";
import type { Achievement } from "@/lib/xp-engine";

export function useHolderTier() {
  const { address, isConnected } = useAccount();
  const [status, setStatus] = useState<HolderTierStatus | null>(null);
  const [state, setState] = useState<HolderTierState | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const refresh = useCallback(() => {
    if (!address) return;
    setStatus(getHolderTierStatus(address));
    setState(getHolderTierState(address));
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setStatus(null);
      setState(null);
      setHasLoaded(false);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  // Holder Score can drift independently of any action here (staking
  // positions unlock, locks release, wallet balance changes on-chain once
  // a real provider is wired in) — periodically recompute, same polling
  // pattern as hooks/usePremium.ts and hooks/useTokenLock.ts.
  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [address, isConnected, refresh]);

  const achievements: Achievement[] = status && state ? getHolderAchievements(status, state) : [];
  const futurePerks = status ? getHolderFuturePerks(status) : null;
  const events = status ? getHolderEvents(status) : [];
  const leaderboardEntry = address ? getHolderLeaderboardEntry(address) : null;

  const claimAchievement = useCallback(
    (achievementId: string) => {
      if (!address) return;
      setState(claimHolderAchievement(address, achievementId));
    },
    [address]
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
