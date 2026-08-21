"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  PREMIUM_TIERS,
  PREMIUM_QUEST_XP_REWARD,
  getPremiumState,
  getPremiumAchievements,
  getPremiumQuests,
  getPremiumCosmetics,
  claimPremiumAchievement,
  claimPremiumQuest,
  claimTreasureBox,
  canClaimTreasureBox,
  hasEarlyMiniGameAccess,
  derivePremiumStatus,
  type PremiumStatus,
  type PremiumState,
} from "@/lib/premium-engine";
import { useTokenLock } from "@/hooks/useTokenLock";
import type { Achievement } from "@/lib/xp-engine";

interface PremiumEvent {
  amount: number;
  id: number;
  kind: "box" | "quest";
}

export function usePremium() {
  const { address, isConnected } = useAccount();
  const {
    totalLocked,
    upcomingUnlockAt,
    loading: lockLoading,
    positions,
  } = useTokenLock();
  const [status, setStatus] = useState<PremiumStatus | null>(null);
  const [state, setState] = useState<PremiumState | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<PremiumEvent | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    if (lockLoading) return;
    const lifetimeLocked = positions.reduce((sum, p) => sum + p.amountFormatted, 0);
    setStatus(
      derivePremiumStatus({
        activeLocked: totalLocked,
        lifetimeLocked,
        nextUnlockAt: upcomingUnlockAt,
      })
    );
    setState(getPremiumState(address));
  }, [address, lockLoading, totalLocked, upcomingUnlockAt, positions]);

  useEffect(() => {
    if (!isConnected || !address) {
      setStatus(null);
      setState(null);
      setHasLoaded(false);
      return;
    }
    if (lockLoading) {
      setHasLoaded(false);
      setStatus(null);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh, lockLoading]);

  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [address, isConnected, refresh]);

  const achievements: Achievement[] = status && state ? getPremiumAchievements(status, state) : [];
  const quests: Achievement[] = status && state ? getPremiumQuests(status, state) : [];
  const cosmetics = status ? getPremiumCosmetics(status.tier) : null;
  const canOpenBox = status && state ? canClaimTreasureBox(status, state) : false;
  const earlyMiniGameAccess = status ? hasEarlyMiniGameAccess(status) : false;

  const claimAchievement = useCallback(
    (achievementId: string) => {
      if (!address) return;
      setState(claimPremiumAchievement(address, achievementId));
    },
    [address]
  );

  const claimQuest = useCallback(
    (questId: string) => {
      if (!address) return;
      const before = getPremiumState(address);
      const alreadyClaimed = before.claimedQuests.includes(questId);
      const next = claimPremiumQuest(address, questId);
      setState(next);
      if (!alreadyClaimed && next.claimedQuests.includes(questId)) {
        setLastEvent({ amount: PREMIUM_QUEST_XP_REWARD, id: Date.now(), kind: "quest" });
      }
    },
    [address]
  );

  const openTreasureBox = useCallback(() => {
    if (!address) return null;
    setError(null);
    const result = claimTreasureBox(address);
    if (!result.success) {
      setError(result.error ?? "Unable to open the Treasure Box right now.");
    } else {
      setState(result.state);
      if (result.amount) setLastEvent({ amount: result.amount, id: Date.now(), kind: "box" });
    }
    return result;
  }, [address]);

  const dismissError = useCallback(() => setError(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  return {
    tiers: PREMIUM_TIERS,
    status,
    state,
    achievements,
    quests,
    cosmetics,
    canOpenBox,
    earlyMiniGameAccess,
    isConnected,
    loading: isConnected && !hasLoaded,
    error,
    lastEvent,
    claimAchievement,
    claimQuest,
    openTreasureBox,
    dismissError,
    dismissEvent,
    refresh,
  };
}
