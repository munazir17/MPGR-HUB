"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  LOCK_OPTIONS,
  claimStakingReward,
  estimateRewards,
  getAvailableBalance,
  getStakingPositions,
  getStakingState,
  stake as stakeAction,
  unstake as unstakeAction,
  type LockDurationDays,
  type StakingPositionView,
  type StakingTransaction,
} from "@/lib/staking-engine";

interface StakeEvent {
  amount: number;
  id: number;
}

export function useStaking() {
  const { address, isConnected } = useAccount();
  const [positions, setPositions] = useState<StakingPositionView[]>([]);
  const [transactions, setTransactions] = useState<StakingTransaction[]>([]);
  const [availableBalance, setAvailableBalance] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<StakeEvent | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    setPositions(getStakingPositions(address));
    setAvailableBalance(getAvailableBalance(address));
    setTransactions(
      [...getStakingState(address).transactions].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
    );
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setPositions([]);
      setTransactions([]);
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

  const activePositionsCount = positions.filter((p) => p.status !== "unstaked").length;

  const stake = useCallback(
    // Phase 2B swap point: once the staking contract exists on Base, this
    // becomes `await writeContractAsync({ ...stakeCall })`.
    (amount: number, lockDurationDays: LockDurationDays) => {
      if (!address) return;
      setError(null);
      const result = stakeAction(address, amount, lockDurationDays);
      if (!result.success) {
        setError(result.error ?? "Unable to stake right now.");
        return;
      }
      refresh();
      if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
    },
    [address, refresh]
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
      refresh();
      if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
    },
    [address, refresh]
  );

  const unstake = useCallback(
    // Phase 2B swap point: replace with an awaited unstake contract call.
    (positionId: string) => {
      if (!address) return;
      setError(null);
      const result = unstakeAction(address, positionId);
      if (!result.success) {
        setError(result.error ?? "Unable to unstake right now.");
        return;
      }
      refresh();
      if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
    },
    [address, refresh]
  );

  const dismissError = useCallback(() => setError(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  return {
    lockOptions: LOCK_OPTIONS,
    estimateRewards,
    positions,
    transactions,
    availableBalance,
    totalStaked,
    totalClaimableRewards,
    activePositionsCount,
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
