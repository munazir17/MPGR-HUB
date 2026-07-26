"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  LOCK_OPTIONS,
  claimStakingReward,
  estimateRewards,
  getAvailableBalance,
  getStakingPositions,
  stake as stakeAction,
  unstake as unstakeAction,
  type LockDurationDays,
  type StakingPositionView,
} from "@/lib/staking-engine";

interface StakeEvent {
  amount: number;
  id: number;
}

export function useStaking() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<StakingPositionView[]>([]);
  const [availableBalance, setAvailableBalance] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<StakeEvent | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    setPositions(getStakingPositions(address));
    setAvailableBalance(getAvailableBalance(address));
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setPositions([]);
      setAvailableBalance(0);
      setHasLoaded(false);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  // Reward accrual is time-based, so periodically recompute the derived
  // views (progress / claimable reward) even without a user action.
  useEffect(() => {
    if (!isConnected || !address) return;
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [address, isConnected, refresh]);

  const totalStaked = positions
    .filter((p) => p.status !== "unstaked")
    .reduce((sum, p) => sum + p.amount, 0);

  const totalClaimableRewards = positions.reduce((sum, p) => sum + p.claimableReward, 0);

  const stake = useCallback(
    (amount: number, lockDurationDays: LockDurationDays) => {
      if (!address) return;
      setError(null);
      const result = stakeAction(address, amount, lockDurationDays);
      if (!result.success) {
        setError(result.error ?? "Unable to stake right now.");
        return;
      }
      setPositions(getStakingPositions(address));
      setAvailableBalance(getAvailableBalance(address));
      if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
    },
    [address]
  );

  const claimReward = useCallback(
    (positionId: string) => {
      if (!address) return;
      setError(null);
      const result = claimStakingReward(address, positionId);
      if (!result.success) {
        setError(result.error ?? "Unable to claim reward right now.");
        return;
      }
      setPositions(getStakingPositions(address));
      setAvailableBalance(getAvailableBalance(address));
      if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
    },
    [address]
  );

  const unstake = useCallback(
    (positionId: string) => {
      if (!address) return;
      setError(null);
      const result = unstakeAction(address, positionId);
      if (!result.success) {
        setError(result.error ?? "Unable to unstake right now.");
        return;
      }
      setPositions(getStakingPositions(address));
      setAvailableBalance(getAvailableBalance(address));
      if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
    },
    [address]
  );

  const dismissError = useCallback(() => setError(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  return {
    lockOptions: LOCK_OPTIONS,
    estimateRewards,
    positions,
    availableBalance,
    totalStaked,
    totalClaimableRewards,
    error,
    lastEvent,
    stake,
    claimReward,
    unstake,
    dismissError,
    dismissEvent,
    loading: isConnected && !hasLoaded,
  };
}
