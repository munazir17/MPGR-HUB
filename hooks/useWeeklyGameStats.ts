"use client";

// hooks/useWeeklyGameStats.ts
//
// Game Rewards Module — thin polling hook over GET
// /api/games/mpgr-run/weekly-status. No client-side computation: every
// field displayed comes directly from the server response, so the UI
// can never show a guaranteed/estimated MPGR number, fake rank, or fake
// eligibility (see section 26 of the master handoff prompt).

import { useCallback, useEffect, useState } from "react";

export interface WeeklyGameStats {
  weekKey: string;
  validRunCount: number;
  bestScore: number;
  eligibilityStatus: "pending" | "eligible" | "ineligible";
  allocationStatus: "none" | "pending" | "allocated" | "failed";
  allocatedAmountRaw: string | null;
  rewardId: string | null;
  allocationTxHash: string | null;
}

const POLL_INTERVAL_MS = 20_000;

export function useWeeklyGameStats(address: string | undefined) {
  const [stats, setStats] = useState<WeeklyGameStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/games/mpgr-run/weekly-status?wallet=${address}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as WeeklyGameStats;
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (!address) {
      setStats(null);
      return;
    }
    void refetch();
    const interval = setInterval(() => void refetch(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [address, refetch]);

  return { stats, isLoading, error, refetch };
}
