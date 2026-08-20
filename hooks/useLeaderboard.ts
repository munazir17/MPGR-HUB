"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount } from "wagmi";

export interface LeaderboardEntry {
  wallet: string;
  rank: number;
  xp: number;
  seasonPoints: number;
  referrals: number;
}

interface LeaderboardResponse {
  top: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  totalRanked: number;
}

export function useLeaderboard() {
  const { address } = useAccount();
  const [top, setTop] = useState<LeaderboardEntry[]>([]);
  const [me, setMe] = useState<LeaderboardEntry | null>(null);
  const [totalRanked, setTotalRanked] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = address ? `?wallet=${address.toLowerCase()}` : "";
      const res = await fetch(`/api/leaderboard${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load leaderboard");
      const data: LeaderboardResponse = await res.json();
      setTop(data.top ?? []);
      setMe(data.me ?? null);
      setTotalRanked(data.totalRanked ?? 0);
    } catch {
      setError("Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { top, me, totalRanked, loading, error, refresh };
}
