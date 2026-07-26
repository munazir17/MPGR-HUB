"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useXP } from "@/hooks/useXP";
import {
  claimAllRewards,
  claimReward,
  getRewardClaims,
  getRewardState,
  type RewardClaim,
} from "@/lib/rewards-engine";

interface ClaimEvent {
  amount: number;
  id: number;
}

export function useRewards() {
  const { address, isConnected } = useAccount();
  const { record } = useXP();
  const [claims, setClaims] = useState<RewardClaim[]>([]);
  const [totalClaimed, setTotalClaimed] = useState(0);
  const [lastClaimEvent, setLastClaimEvent] = useState<ClaimEvent | null>(null);

  useEffect(() => {
    if (!isConnected || !address || !record) {
      setClaims([]);
      setTotalClaimed(0);
      return;
    }
    setClaims(getRewardClaims(record));
    setTotalClaimed(getRewardState(address).totalClaimed);
  }, [address, isConnected, record]);

  const claimableTotal = claims
    .filter((c) => c.unlocked && !c.claimed)
    .reduce((sum, c) => sum + c.amount, 0);

  const claim = useCallback(
    (rewardId: string) => {
      if (!address) return;
      const result = claimReward(address, rewardId);
      setClaims(result.claims);
      if (result.claimedAmount > 0) {
        setTotalClaimed((prev) => prev + result.claimedAmount);
        setLastClaimEvent({ amount: result.claimedAmount, id: Date.now() });
      }
    },
    [address]
  );

  const claimAll = useCallback(() => {
    if (!address) return;
    const result = claimAllRewards(address);
    setClaims(result.claims);
    if (result.claimedAmount > 0) {
      setTotalClaimed((prev) => prev + result.claimedAmount);
      setLastClaimEvent({ amount: result.claimedAmount, id: Date.now() });
    }
  }, [address]);

  const dismissClaimEvent = useCallback(() => setLastClaimEvent(null), []);

  return {
    claims,
    claimableTotal,
    totalClaimed,
    claim,
    claimAll,
    lastClaimEvent,
    dismissClaimEvent,
    loading: isConnected && !record,
  };
}
