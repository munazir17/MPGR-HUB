"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  burnTokens as burnTokensAction,
  estimateRemainingBalance,
  estimateSupplyImpact,
  getAvailableBalance,
  getBurnAchievements,
  getBurnDashboardStats,
  getBurnLeaderboard,
  getBurnMilestones,
  getBurnState,
} from "@/lib/burn-engine";
import { BURN_TOTAL_SUPPLY } from "@/lib/burn-utils";
import type { BurnActionResult, BurnState, BurnTransaction } from "@/lib/burn-types";

interface BurnEvent {
  amount: number;
  id: number;
}

export function useBurn() {
  const { address, isConnected } = useAccount();
  const [state, setState] = useState<BurnState | null>(null);
  const [availableBalance, setAvailableBalance] = useState(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<BurnEvent | null>(null);

  const refresh = useCallback(() => {
    if (!address) return;
    setState(getBurnState(address));
    setAvailableBalance(getAvailableBalance(address));
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address) {
      setState(null);
      setAvailableBalance(0);
      setHasLoaded(false);
      return;
    }
    refresh();
    setHasLoaded(true);
  }, [address, isConnected, refresh]);

  const transactions: BurnTransaction[] = state?.transactions ?? [];
  const totalBurned = state?.totalBurned ?? 0;

  const stats = getBurnDashboardStats(state ?? { address: "", transactions: [], totalBurned: 0 });
  const milestones = getBurnMilestones(totalBurned);
  const achievements = getBurnAchievements(state ?? { address: "", transactions: [], totalBurned: 0 });
  const leaderboard = address ? getBurnLeaderboard(address, totalBurned) : [];

  const previewImpact = useCallback(
    (amount: number) => estimateSupplyImpact(totalBurned, amount, BURN_TOTAL_SUPPLY),
    [totalBurned]
  );

  const previewRemainingBalance = useCallback(
    (amount: number) => estimateRemainingBalance(availableBalance, amount),
    [availableBalance]
  );

  const burn = useCallback(
    // Phase 2B swap point: once the burn contract exists on Base, this
    // becomes `await writeContractAsync({ ...prepareTransaction(...) })`.
    (amount: number): BurnActionResult => {
      if (!address) {
        return {
          success: false,
          error: "Connect your wallet to burn MPGR.",
          state: { address: "", transactions: [], totalBurned: 0 },
        };
      }
      setError(null);
      const result = burnTokensAction(address, amount);
      if (!result.success) {
        setError(result.error ?? "Unable to burn MPGR right now.");
      } else {
        refresh();
        if (result.amount) setLastEvent({ amount: result.amount, id: Date.now() });
      }
      return result;
    },
    [address, refresh]
  );

  const dismissError = useCallback(() => setError(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  return {
    totalSupply: BURN_TOTAL_SUPPLY,
    transactions,
    totalBurned,
    availableBalance,
    stats,
    milestones,
    achievements,
    leaderboard,
    error,
    lastEvent,
    burn,
    previewImpact,
    previewRemainingBalance,
    dismissError,
    dismissEvent,
    loading: isConnected && !hasLoaded,
  };
}
