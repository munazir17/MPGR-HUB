"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import {
  awardXP,
  claimAchievement,
  getUserRecord,
  getSeasonPoints,
  performDailyCheckIn,
  type UserXPRecord,
  type GameAchievementStats,
} from "@/lib/xp-engine";

interface XPEvent {
  amount: number;
  id: number;
}

// Bug fix — global leaderboard.
//
// lib/xp-engine.ts stays exactly as it was (a local, per-browser XP
// cache — untouched). The only addition here is a fire-and-forget sync
// of {wallet, xp, seasonPoints} to the server-side leaderboard store
// (see lib/leaderboard/leaderboard-store.ts) whenever the local record
// changes, so every OTHER wallet's leaderboard page can see this
// wallet's standing too — not just this browser.
function syncLeaderboard(record: UserXPRecord) {
  try {
    fetch("/api/leaderboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: record.address,
        xp: record.xp,
        seasonPoints: getSeasonPoints(record),
      }),
    }).catch(() => {
      // Best-effort — a failed sync just means this update won't be
      // visible globally until the next successful sync; local XP is
      // completely unaffected either way.
    });
  } catch {
    // ignore — never let leaderboard sync break local XP behavior
  }
}

export function useXP() {
  const { address, isConnected } = useAccount();
  const [record, setRecord] = useState<UserXPRecord | null>(null);
  const [lastEvent, setLastEvent] = useState<XPEvent | null>(null);
  const [leveledUp, setLeveledUp] = useState<number | null>(null);

  useEffect(() => {
    if (!isConnected || !address) {
      setRecord(null);
      return;
    }
    const result = awardXP(address, "WALLET_CONNECTED");
    setRecord(result.record);
    syncLeaderboard(result.record);
    if (result.xpGained > 0) {
      setLastEvent({ amount: result.xpGained, id: Date.now() });
    }
    if (result.leveledUp) setLeveledUp(result.newLevel);
  }, [address, isConnected]);

  const checkIn = useCallback(() => {
    if (!address) return null;
    const result = performDailyCheckIn(address);
    setRecord(result.record);
    syncLeaderboard(result.record);
    if (result.xpGained > 0) setLastEvent({ amount: result.xpGained, id: Date.now() });
    if (result.leveledUp) setLeveledUp(result.newLevel);
    return result;
  }, [address]);

  const claim = useCallback(
    (achievementId: string, gameStats?: GameAchievementStats) => {
      if (!address) return;
      const updated = claimAchievement(address, achievementId, gameStats);
      setRecord(updated);
      syncLeaderboard(updated);
    },
    [address]
  );

  const dismissLevelUp = useCallback(() => setLeveledUp(null), []);
  const dismissEvent = useCallback(() => setLastEvent(null), []);

  const refresh = useCallback(() => {
    if (!address) return;
    setRecord(getUserRecord(address));
  }, [address]);

  return { record, checkIn, claim, refresh, isConnected, lastEvent, leveledUp, dismissLevelUp, dismissEvent };
}
