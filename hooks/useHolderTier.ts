// hooks/useHolderTier.ts

"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
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
import { balanceService } from "@/lib/token/balance-service";
import { stakingService } from "@/lib/staking/staking-service";
import type { Achievement } from "@/lib/xp-engine";

export function useHolderTier() {
  const { address, isConnected } = useAccount();
  const [status, setStatus] = useState<HolderTierStatus | null>(null);
  const [state, setState] = useState<HolderTierState | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  // Tracks whether this session's live wallet/staked balances have been
  // fetched at least once for the current address — separate from
  // hasLoaded, which flips true immediately off whatever is already in
  // holder-score-providers.ts's cache (often nothing on a fresh page load,
  // since that cache is normally warmed by useStaking()/useTokenLock() on
  // pages that mount them, and Holder Tier is shown on pages that don't,
  // e.g. /premium, /profile). Without this, Wallet Balance could render a
  // confirmed-looking 0 instead of a loading state on those pages.
  const [balancesWarmed, setBalancesWarmed] = useState(false);

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
      setBalancesWarmed(false);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  // Holder Score is read synchronously from holder-score-providers.ts's
  // caches (see that file), which are otherwise only warmed as a side
  // effect of mounting useStaking()/useTokenLock() elsewhere. Fetch both
  // sources directly here too — same services those hooks already use, no
  // duplicate logic — so Holder Tier is correct on every page it appears
  // on, not just ones that happen to also render Staking/Token Lock.
  useEffect(() => {
    if (!isConnected || !address) return;
    let cancelled = false;
    setBalancesWarmed(false);
    Promise.all([
      balanceService.getRawBalance(address as Address),
      stakingService.getWalletState(address as Address),
    ])
      .catch(() => {
        // Both services already fail safe internally (0n / cache miss) and
        // log their own errors — nothing else to do here except stop
        // blocking the loading state on a request that's never coming.
      })
      .finally(() => {
        if (cancelled) return;
        setBalancesWarmed(true);
        refresh();
      });
    return () => {
      cancelled = true;
    };
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
    loading: isConnected && (!hasLoaded || !balancesWarmed),
    claimAchievement,
    refresh,
  };
}
