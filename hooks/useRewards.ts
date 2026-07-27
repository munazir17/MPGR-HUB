"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useXP } from "@/hooks/useXP";
import {
  claimAllRewards,
  claimReward,
  getClaimedInWindow,
  getRewardClaims,
  getRewardState,
  getWeeklyClaimSeries,
  type RewardClaim,
  type RewardClaimHistoryEntry,
} from "@/lib/rewards-engine";

interface ClaimEvent {
  amount: number;
  id: number;
}

// Small artificial delay before a claim resolves so the action reads as a
// real transaction instead of an instant state flip. Purely a UX wrapper —
// the underlying claim logic in lib/rewards-engine.ts is untouched, and the
// resulting state is identical either way.
const CLAIM_FEEDBACK_MS = 550;

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function useRewards() {
  const { address, isConnected } = useAccount();
  const { record } = useXP();
  const [claims, setClaims] = useState<RewardClaim[]>([]);
  const [totalClaimed, setTotalClaimed] = useState(0);
  const [claimHistory, setClaimHistory] = useState<RewardClaimHistoryEntry[]>([]);
  const [lastClaimEvent, setLastClaimEvent] = useState<ClaimEvent | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimingAll, setClaimingAll] = useState(false);

  const refreshHistory = useCallback(() => {
    if (!address) return;
    setClaimHistory(
      [...getRewardState(address).history].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
    );
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address || !record) {
      setClaims([]);
      setTotalClaimed(0);
      setClaimHistory([]);
      return;
    }
    setClaims(getRewardClaims(record));
    setTotalClaimed(getRewardState(address).totalClaimed);
    refreshHistory();
  }, [address, isConnected, record, refreshHistory]);

  const claimableTotal = claims
    .filter((c) => c.unlocked && !c.claimed)
    .reduce((sum, c) => sum + c.amount, 0);

  const claim = useCallback(
    async (rewardId: string) => {
      if (!address || claimingId || claimingAll) return;
      setClaimingId(rewardId);
      try {
        await wait(CLAIM_FEEDBACK_MS);
        const result = claimReward(address, rewardId);
        setClaims(result.claims);
        if (result.claimedAmount > 0) {
          setTotalClaimed((prev) => prev + result.claimedAmount);
          setLastClaimEvent({ amount: result.claimedAmount, id: Date.now() });
          refreshHistory();
        }
      } finally {
        setClaimingId(null);
      }
    },
    [address, claimingId, claimingAll, refreshHistory]
  );

  const claimAll = useCallback(async () => {
    if (!address || claimingId || claimingAll) return;
    setClaimingAll(true);
    try {
      await wait(CLAIM_FEEDBACK_MS);
      const result = claimAllRewards(address);
      setClaims(result.claims);
      if (result.claimedAmount > 0) {
        setTotalClaimed((prev) => prev + result.claimedAmount);
        setLastClaimEvent({ amount: result.claimedAmount, id: Date.now() });
        refreshHistory();
      }
    } finally {
      setClaimingAll(false);
    }
  }, [address, claimingId, claimingAll, refreshHistory]);

  const dismissClaimEvent = useCallback(() => setLastClaimEvent(null), []);

  // Derived weekly stats — computed from claimHistory only, no extra
  // storage reads. Memoized so the page doesn't recompute on every render.
  const weeklySeries = useMemo(() => getWeeklyClaimSeries(claimHistory), [claimHistory]);
  const weeklyClaimed = useMemo(
    () => weeklySeries.reduce((sum, d) => sum + d.amount, 0),
    [weeklySeries]
  );
  const previousWeekClaimed = useMemo(
    () => getClaimedInWindow(claimHistory, 14, 7),
    [claimHistory]
  );

  return {
    claims,
    claimableTotal,
    totalClaimed,
    claimHistory,
    claim,
    claimAll,
    lastClaimEvent,
    dismissClaimEvent,
    loading: isConnected && !record,
    claimingId,
    claimingAll,
    weeklySeries,
    weeklyClaimed,
    previousWeekClaimed,
  };
}
