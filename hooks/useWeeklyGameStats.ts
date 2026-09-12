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
      const res = await fetch(`/api/games/mpgr-run/weekly-status?wallet=${address}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (res.status === 401) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const retry = await fetch(`/api/games/mpgr-run/weekly-status?wallet=${address}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!retry.ok) throw new Error(`Request failed (${retry.status})`);
        const retryData = (await retry.json()) as WeeklyGameStats;
        setStats(retryData);
        setError(null);
        return;
      }
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

    const onRunAccepted = (event: Event) => {
      const detail = (event as CustomEvent).detail as WeeklyGameStats | null | undefined;
      if (detail && typeof detail.validRunCount === "number") {
        setStats((prev) => ({
          weekKey: prev?.weekKey ?? "",
          validRunCount: detail.validRunCount,
          bestScore: detail.bestScore,
          eligibilityStatus: detail.eligibilityStatus,
          allocationStatus: prev?.allocationStatus ?? "none",
          allocatedAmountRaw: prev?.allocatedAmountRaw ?? null,
          rewardId: prev?.rewardId ?? null,
          allocationTxHash: prev?.allocationTxHash ?? null,
        }));
      }
      void refetch();
    };

    window.addEventListener("mpgr-run:weekly-stats-updated", onRunAccepted);

    return () => {
      clearInterval(interval);
      window.removeEventListener("mpgr-run:weekly-stats-updated", onRunAccepted);
    };
  }, [address, refetch]);

  return { stats, isLoading, error, refetch };
}
